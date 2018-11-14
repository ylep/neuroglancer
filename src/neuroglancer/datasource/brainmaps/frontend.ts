/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AnnotationSource, AnnotationType, makeDataBoundsBoundingBox} from 'neuroglancer/annotation';
import {AnnotationGeometryChunkSpecification} from 'neuroglancer/annotation/base';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend';
import {ChunkManager, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {WithCredentialsProvider} from 'neuroglancer/credentials_provider/chunk_source_frontend';
import {DataSource, GetVolumeOptions} from 'neuroglancer/datasource';
import {BrainmapsCredentialsProvider, BrainmapsInstance, Credentials, makeRequest} from 'neuroglancer/datasource/brainmaps/api';
import {AnnotationSourceParameters, ChangeSpec, MeshSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeSourceParameters} from 'neuroglancer/datasource/brainmaps/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {ChunkLayoutPreference} from 'neuroglancer/sliceview/base';
import {DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {getPrefixMatches, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {mat4, vec3} from 'neuroglancer/util/geom';
import {parseArray, parseQueryStringParameters, parseXYZ, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyMapKey, verifyObject, verifyObjectProperty, verifyOptionalString, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import {getObjectId} from 'neuroglancer/util/object_id';

class BrainmapsVolumeChunkSource extends
(WithParameters(
    WithCredentialsProvider<Credentials>()(VolumeChunkSource), VolumeSourceParameters)) {}

class BrainmapsMeshSource extends
(WithParameters(WithCredentialsProvider<Credentials>()(MeshSource), MeshSourceParameters)) {}

export class BrainmapsSkeletonSource extends
(WithParameters(WithCredentialsProvider<Credentials>()(SkeletonSource), SkeletonSourceParameters)) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
}

const SERVER_DATA_TYPES = new Map<string, DataType>();
SERVER_DATA_TYPES.set('UINT8', DataType.UINT8);
SERVER_DATA_TYPES.set('FLOAT', DataType.FLOAT32);
SERVER_DATA_TYPES.set('UINT64', DataType.UINT64);

function parseBoundingBox(obj: any) {
  verifyObject(obj);
  try {
    return {
      corner:
          verifyObjectProperty(obj, 'corner', x => parseXYZ(vec3.create(), x, verifyFiniteFloat)),
      size: verifyObjectProperty(
          obj, 'size', x => parseXYZ(vec3.create(), x, verifyFinitePositiveFloat)),
      metadata: verifyObjectProperty(obj, 'metadata', verifyOptionalString),
    };
  } catch (parseError) {
    throw new Error(`Failed to parse bounding box: ${parseError.message}`);
  }
}

export class VolumeInfo {
  numChannels: number;
  dataType: DataType;
  voxelSize: vec3;
  upperVoxelBound: vec3;
  boundingBoxes: {corner: vec3, size: vec3, metadata?: string}[];
  constructor(obj: any) {
    try {
      verifyObject(obj);
      this.numChannels = verifyObjectProperty(obj, 'channelCount', verifyPositiveInt);
      this.dataType =
          verifyObjectProperty(obj, 'channelType', x => verifyMapKey(x, SERVER_DATA_TYPES));
      this.voxelSize = verifyObjectProperty(
          obj, 'pixelSize', x => parseXYZ(vec3.create(), x, verifyFinitePositiveFloat));
      this.upperVoxelBound = verifyObjectProperty(
          obj, 'volumeSize', x => parseXYZ(vec3.create(), x, verifyPositiveInt));
      this.boundingBoxes = verifyObjectProperty(
          obj, 'boundingBox', a => a === undefined ? [] : parseArray(a, parseBoundingBox));
    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps volume geometry: ${parseError.message}`);
    }
  }
}

export class MultiscaleVolumeInfo {
  scales: VolumeInfo[];
  numChannels: number;
  dataType: DataType;
  constructor(volumeInfoResponse: any) {
    try {
      verifyObject(volumeInfoResponse);
      let scales = this.scales = verifyObjectProperty(
          volumeInfoResponse, 'geometry', y => parseArray(y, x => new VolumeInfo(x)));
      if (scales.length === 0) {
        throw new Error('Expected at least one scale.');
      }
      let baseScale = scales[0];
      let numChannels = this.numChannels = baseScale.numChannels;
      let dataType = this.dataType = baseScale.dataType;
      for (let scaleIndex = 1, numScales = scales.length; scaleIndex < numScales; ++scaleIndex) {
        let scale = scales[scaleIndex];
        if (scale.dataType !== dataType) {
          throw new Error(
              `Scale ${scaleIndex} has data type ${DataType[scale.dataType]} ` +
              `but scale 0 has data type ${DataType[dataType]}.`);
        }
        if (scale.numChannels !== numChannels) {
          throw new Error(
              `Scale ${scaleIndex} has ${scale.numChannels} channel(s) ` +
              `but scale 0 has ${numChannels} channels.`);
        }
      }
    } catch (parseError) {
      throw new Error(
          `Failed to parse BrainMaps multiscale volume specification: ${parseError.message}`);
    }
  }
}

export class MeshInfo {
  name: string;
  type: string;
  constructor(obj: any) {
    verifyObject(obj);
    this.name = verifyObjectProperty(obj, 'name', verifyString);
    this.type = verifyObjectProperty(obj, 'type', verifyString);
  }
}

export interface GetBrainmapsVolumeOptions extends GetVolumeOptions {
  encoding?: VolumeChunkEncoding;
  chunkLayoutPreference?: ChunkLayoutPreference;
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  volumeType: VolumeType;
  get scales() {
    return this.multiscaleVolumeInfo.scales;
  }
  get dataType() {
    return this.multiscaleVolumeInfo.dataType;
  }
  get numChannels() {
    return this.multiscaleVolumeInfo.numChannels;
  }
  meshes: MeshInfo[];
  encoding: VolumeChunkEncoding|undefined;
  chunkLayoutPreference: ChunkLayoutPreference|undefined;
  constructor(
      public chunkManager: ChunkManager, public instance: BrainmapsInstance,
      public credentialsProvider: Borrowed<BrainmapsCredentialsProvider>, public volumeId: string,
      public changeSpec: ChangeSpec|undefined, public multiscaleVolumeInfo: MultiscaleVolumeInfo,
      meshesResponse: any, options: GetBrainmapsVolumeOptions) {
    this.encoding = options.encoding;
    this.chunkLayoutPreference = options.chunkLayoutPreference;

    // Infer the VolumeType from the data type and number of channels.
    let volumeType: VolumeType|undefined;
    if (this.numChannels === 1) {
      switch (this.dataType) {
        case DataType.UINT64:
          volumeType = VolumeType.SEGMENTATION;
          break;
      }
    }
    if (volumeType === undefined) {
      if (options.volumeType !== undefined) {
        volumeType = options.volumeType;
      } else {
        volumeType = VolumeType.IMAGE;
      }
    }
    this.volumeType = volumeType;

    try {
      verifyObject(meshesResponse);
      this.meshes = verifyObjectProperty(meshesResponse, 'meshes', y => {
        if (y === undefined) {
          return [];
        }
        return parseArray(y, x => new MeshInfo(x));
      });
    } catch (parseError) {
      throw new Error(`Failed to parse BrainMaps meshes specification: ${parseError.message}`);
    }
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let encoding = VolumeChunkEncoding.RAW;
    if (this.dataType === DataType.UINT64) {
      encoding = VolumeChunkEncoding.COMPRESSED_SEGMENTATION;
    } else if (
        this.volumeType === VolumeType.IMAGE && this.dataType === DataType.UINT8 &&
        this.numChannels === 1 && this.encoding !== VolumeChunkEncoding.RAW) {
      encoding = VolumeChunkEncoding.JPEG;
    }

    const baseScale = this.scales[0];
    const upperClipBound =
        vec3.multiply(vec3.create(), baseScale.upperVoxelBound, baseScale.voxelSize);

    return this.scales.map(
        (volumeInfo, scaleIndex) => VolumeChunkSpecification
                                        .getDefaults({
                                          voxelSize: volumeInfo.voxelSize,
                                          dataType: volumeInfo.dataType,
                                          numChannels: volumeInfo.numChannels,
                                          upperVoxelBound: volumeInfo.upperVoxelBound,
                                          upperClipBound,
                                          volumeType: this.volumeType,
                                          volumeSourceOptions,
                                          chunkLayoutPreference: this.chunkLayoutPreference,
                                          maxCompressedSegmentationBlockSize:
                                              vec3.fromValues(64, 64, 64),
                                        })
                                        .map(spec => {
                                          return this.chunkManager.getChunkSource(
                                              BrainmapsVolumeChunkSource, {
                                                credentialsProvider: this.credentialsProvider,
                                                spec,
                                                parameters: {
                                                  'instance': this.instance,
                                                  'volumeId': this.volumeId,
                                                  'changeSpec': this.changeSpec,
                                                  'scaleIndex': scaleIndex,
                                                  'encoding': encoding,
                                                }
                                              });
                                        }));
  }

  getMeshSource() {
    for (const mesh of this.meshes) {
      if (mesh.type === 'TRIANGLES') {
        return this.chunkManager.getChunkSource(BrainmapsMeshSource, {
          credentialsProvider: this.credentialsProvider,
          parameters: {
            'instance': this.instance,
            'volumeId': this.volumeId,
            'meshName': mesh.name,
            'changeSpec': this.changeSpec,
          }
        });
      } else if (mesh.type === 'LINE_SEGMENTS') {
        return this.chunkManager.getChunkSource(BrainmapsSkeletonSource, {
          credentialsProvider: this.credentialsProvider,
          parameters: {
            'instance': this.instance,
            'volumeId': this.volumeId,
            'meshName': mesh.name,
            'changeSpec': this.changeSpec,
          }
        });
      }
    }
    return null;
  }

  getStaticAnnotations() {
    const baseScale = this.scales[0];
    const annotationSet =
        new AnnotationSource(mat4.fromScaling(mat4.create(), baseScale.voxelSize));
    annotationSet.readonly = true;
    annotationSet.add(makeDataBoundsBoundingBox(vec3.create(), baseScale.upperVoxelBound));

    baseScale.boundingBoxes.forEach((boundingBox, i) => {
      annotationSet.add({
        type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
        description: boundingBox.metadata,
        pointA: boundingBox.corner,
        pointB: vec3.add(vec3.create(), boundingBox.corner, boundingBox.size),
        id: `boundingBox${i}`,
      });
    });
    return annotationSet;
  }
}


export function parseVolumeKey(key: string):
    {volumeId: string, changeSpec: ChangeSpec|undefined, parameters: any} {
  const match = key.match(/^([^:?]+:[^:?]+:[^:?]+)(?::([^:?]+))?(?:\?(.*))?$/);
  if (match === null) {
    throw new Error(`Invalid Brain Maps volume key: ${JSON.stringify(key)}.`);
  }
  let changeSpec: ChangeSpec|undefined;
  if (match[2] !== undefined) {
    changeSpec = {changeStackId: match[2]};
  }
  const parameters = parseQueryStringParameters(match[3] || '');
  return {volumeId: match[1], changeSpec, parameters};
}

const meshSourcePattern = /^([^\/]+)\/(.*)$/;


interface ProjectMetadata {
  id: string;
  label: string;
  description?: string;
}

function parseProject(obj: any): ProjectMetadata {
  try {
    verifyObject(obj);
    return {
      id: verifyObjectProperty(obj, 'id', verifyString),
      label: verifyObjectProperty(obj, 'label', verifyString),
      description: verifyObjectProperty(obj, 'description', verifyOptionalString),
    };
  } catch (parseError) {
    throw new Error(`Failed to parse project: ${parseError.message}`);
  }
}

function parseProjectList(obj: any) {
  try {
    verifyObject(obj);
    return verifyObjectProperty(
        obj, 'project', x => x === undefined ? [] : parseArray(x, parseProject));
  } catch (parseError) {
    throw new Error(`Error parsing project list: ${parseError.message}`);
  }
}

export class VolumeList {
  volumeIds: string[];
  projects = new Map<string, ProjectMetadata>();
  hierarchicalVolumeIds = new Map<string, string[]>();
  constructor(projectsResponse: any, volumesResponse: any) {
    const {projects} = this;
    for (let project of parseProjectList(projectsResponse)) {
      projects.set(project.id, project);
    }
    try {
      verifyObject(volumesResponse);
      let volumeIds = this.volumeIds = verifyObjectProperty(
          volumesResponse, 'volumeId', x => x === undefined ? [] : parseArray(x, verifyString));
      volumeIds.sort();
      let hierarchicalSets = new Map<string, Set<string>>();
      for (let volumeId of volumeIds) {
        let componentStart = 0;
        while (true) {
          let nextColon: number|undefined = volumeId.indexOf(':', componentStart);
          if (nextColon === -1) {
            nextColon = undefined;
          } else {
            ++nextColon;
          }
          let groupString = volumeId.substring(0, componentStart);
          let group = hierarchicalSets.get(groupString);
          if (group === undefined) {
            group = new Set<string>();
            hierarchicalSets.set(groupString, group);
          }
          group.add(volumeId.substring(componentStart, nextColon));
          if (nextColon === undefined) {
            break;
          }
          componentStart = nextColon;
        }
      }
      let {hierarchicalVolumeIds} = this;
      for (let [group, valueSet] of hierarchicalSets) {
        hierarchicalVolumeIds.set(group, Array.from(valueSet));
      }
    } catch (parseError) {
      throw new Error(`Failed to parse Brain Maps volume list reply: ${parseError.message}`);
    }
  }
}


export function parseChangeStackList(x: any) {
  return verifyObjectProperty(
      x, 'changeStackId', y => y === undefined ? undefined : parseArray(y, verifyString));
}

function makeAnnotationGeometrySourceSpecifications(multiscaleInfo: MultiscaleVolumeInfo) {
  const baseScale = multiscaleInfo.scales[0];
  const spec = new AnnotationGeometryChunkSpecification({
    voxelSize: baseScale.voxelSize,
    chunkSize: vec3.multiply(vec3.create(), baseScale.upperVoxelBound, baseScale.voxelSize),
    upperChunkBound: vec3.fromValues(1, 1, 1),
  });
  return [[{parameters: undefined, spec}]];
}

const MultiscaleAnnotationSourceBase = (WithParameters(
    WithCredentialsProvider<Credentials>()(MultiscaleAnnotationSource),
    AnnotationSourceParameters));

export class BrainmapsAnnotationSource extends MultiscaleAnnotationSourceBase {
  constructor(chunkManager: ChunkManager, options: {
    credentialsProvider: CredentialsProvider<Credentials>,
    parameters: AnnotationSourceParameters,
    multiscaleVolumeInfo: MultiscaleVolumeInfo
  }) {
    super(chunkManager, <any>{
      sourceSpecifications:
          makeAnnotationGeometrySourceSpecifications(options.multiscaleVolumeInfo),
      ...options
    });
    mat4.fromScaling(this.objectToLocal, options.multiscaleVolumeInfo.scales[0].voxelSize);
  }
}

export class BrainmapsDataSource extends DataSource {
  constructor(
      public instance: BrainmapsInstance,
      public credentialsProvider: Owned<BrainmapsCredentialsProvider>) {
    super();
  }

  get description() {
    return this.instance.description;
  }

  getMeshSource(chunkManager: ChunkManager, url: string) {
    return chunkManager.getChunkSource(BrainmapsMeshSource, {
      credentialsProvider: this.credentialsProvider,
      parameters: this.getMeshSourceParameters(url)
    });
  }


  getMeshSourceParameters(url: string) {
    let match = url.match(meshSourcePattern);
    if (match === null) {
      throw new Error(`Invalid Brainmaps mesh URL: ${url}`);
    }
    let {volumeId, changeSpec} = parseVolumeKey(match[1]);
    return {instance: this.instance, volumeId, changeSpec, meshName: match[2]};
  }

  getSkeletonSource(chunkManager: ChunkManager, url: string) {
    return chunkManager.getChunkSource(BrainmapsSkeletonSource, {
      credentialsProvider: this.credentialsProvider,
      parameters: this.getMeshSourceParameters(url)
    });
  }

  getMultiscaleInfo(chunkManager: ChunkManager, volumeId: string) {
    return chunkManager.memoize.getUncounted(
        {
          type: 'brainmaps:getMultiscaleInfo',
          volumeId,
          instance: this.instance,
          credentialsProvider: getObjectId(this.credentialsProvider)
        },
        () => makeRequest(this.instance, this.credentialsProvider, {
                method: 'GET',
                path: `/v1beta2/volumes/${volumeId}`,
                responseType: 'json'
              }).then(response => new MultiscaleVolumeInfo(response)));
  }

  getVolume(chunkManager: ChunkManager, key: string, options: GetVolumeOptions) {
    const {volumeId, changeSpec, parameters} = parseVolumeKey(key);
    verifyObject(parameters);
    const encoding = verifyObjectProperty(
        parameters, 'encoding',
        x => x === undefined ? undefined : verifyEnumString(x, VolumeChunkEncoding));
    const chunkLayoutPreference = verifyObjectProperty(
        parameters, 'chunkLayout',
        x => x === undefined ? undefined : verifyEnumString(x, ChunkLayoutPreference));
    const brainmapsOptions:
        GetBrainmapsVolumeOptions = {...options, encoding, chunkLayoutPreference};
    return chunkManager.memoize.getUncounted(
        {
          type: 'brainmaps:getVolume',
          instance: this.instance,
          volumeId,
          changeSpec,
          brainmapsOptions
        },
        () => Promise
                  .all([
                    this.getMultiscaleInfo(chunkManager, volumeId),
                    makeRequest(this.instance, this.credentialsProvider, {
                      method: 'GET',
                      path: `/v1beta2/objects/${volumeId}/meshes`,
                      responseType: 'json'
                    }),
                  ])
                  .then(
                      ([multiscaleVolumeInfo, meshesResponse]) => new MultiscaleVolumeChunkSource(
                          chunkManager, this.instance, this.credentialsProvider, volumeId,
                          changeSpec, multiscaleVolumeInfo, meshesResponse, brainmapsOptions)));
  }

  getAnnotationSource(chunkManager: ChunkManager, key: string) {
    const {volumeId, changeSpec} = parseVolumeKey(key);
    if (changeSpec === undefined) {
      throw new Error(`A changestack must be specified.`);
    }
    const parameters = {
      instance: this.instance,
      volumeId,
      changestack: changeSpec.changeStackId,
    };
    return chunkManager.memoize.getUncounted(
        {
          type: 'brainmaps:getAnnotationSource',
          instance: this.instance,
          credentialsProvider: getObjectId(this.credentialsProvider),
          parameters
        },
        () =>
            this.getMultiscaleInfo(chunkManager, volumeId)
                .then(
                    multiscaleVolumeInfo => chunkManager.getChunkSource(BrainmapsAnnotationSource, {
                      parameters,
                      credentialsProvider: this.credentialsProvider,
                      multiscaleVolumeInfo
                    })));
  }

  getVolumeList(chunkManager: ChunkManager) {
    return chunkManager.memoize.getUncounted(
        {instance: this.instance, type: 'brainmaps:getVolumeList'}, () => {
          let promise = Promise
                            .all([
                              makeRequest(
                                  this.instance, this.credentialsProvider,
                                  {method: 'GET', path: '/v1beta2/projects', responseType: 'json'}),
                              makeRequest(
                                  this.instance, this.credentialsProvider,
                                  {method: 'GET', path: '/v1beta2/volumes', responseType: 'json'})
                            ])
                            .then(
                                ([projectsResponse, volumesResponse]) =>
                                    new VolumeList(projectsResponse, volumesResponse));
          const description = `${this.instance.description} volume list`;
          StatusMessage.forPromise(promise, {
            delay: true,
            initialMessage: `Retrieving ${description}.`,
            errorPrefix: `Error retrieving ${description}: `,
          });
          return promise;
        });
  }

  getChangeStackList(chunkManager: ChunkManager, volumeId: string) {
    return chunkManager.memoize.getUncounted(
        {instance: this.instance, type: 'brainmaps:getChangeStackList', volumeId}, () => {
          let promise: Promise<string[]|undefined> =
              makeRequest(this.instance, this.credentialsProvider, {
                method: 'GET',
                path: `/v1beta2/changes/${volumeId}/change_stacks`,
                responseType: 'json'
              }).then(response => parseChangeStackList(response));
          const description = `change stacks for ${volumeId}`;
          StatusMessage.forPromise(promise, {
            delay: true,
            initialMessage: `Retrieving ${description}.`,
            errorPrefix: `Error retrieving ${description}: `,
          });
          return promise;
        });
  }

  volumeCompleter(url: string, chunkManager: ChunkManager) {
    return this.getVolumeList(chunkManager).then(volumeList => {
      // Check if there is a valid 3-part volume id followed by a colon, in which case we complete
      // the change stack name.
      const changeStackMatch = url.match(/^([^:]+:[^:]+:[^:]+):(.*)$/);
      if (changeStackMatch !== null) {
        const volumeId = changeStackMatch[1];
        const matchString = changeStackMatch[2];
        return this.getChangeStackList(chunkManager, volumeId).then(changeStacks => {
          if (changeStacks === undefined) {
            throw null;
          }
          return {
            offset: volumeId.length + 1,
            completions: getPrefixMatches(matchString, changeStacks)
          };
        });
      }
      let lastColon = url.lastIndexOf(':');
      let splitPoint = lastColon + 1;
      let prefix = url.substring(0, splitPoint);
      let matchString = url.substring(splitPoint);
      let possibleMatches = volumeList.hierarchicalVolumeIds.get(prefix);
      if (possibleMatches === undefined) {
        throw null;
      }
      if (prefix) {
        // Project id already matched.
        return {offset: prefix.length, completions: getPrefixMatches(matchString, possibleMatches)};
      } else {
        return {
          offset: 0,
          completions: getPrefixMatchesWithDescriptions(
              matchString, possibleMatches, x => x,
              x => {
                const metadata = volumeList.projects.get(x.substring(0, x.length - 1));
                return metadata && metadata.label;
              })
        };
      }
    });
  }
}

export const productionInstance: BrainmapsInstance = {
  description: 'Google Brain Maps',
  serverUrls: ['https://brainmaps.googleapis.com'],
};
