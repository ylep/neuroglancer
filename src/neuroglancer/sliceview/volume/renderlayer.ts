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

import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {getTransformedSources} from 'neuroglancer/sliceview/base';
import {BoundingBoxCrossSectionRenderHelper} from 'neuroglancer/sliceview/bounding_box_shader_helper';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {RenderLayer as SliceViewRenderLayer, RenderLayerOptions as SliceViewRenderLayerOptions} from 'neuroglancer/sliceview/renderlayer';
import {VolumeChunkSpecification, VolumeSourceOptions} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {mat4, vec3, vec3Key} from 'neuroglancer/util/geom';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';

const DEBUG_VERTICES = false;

/**
 * Extra amount by which the chunk position computed in the vertex shader is shifted in the
 * direction of the component-wise absolute value of the plane normal.  In Neuroglancer, a
 * cross-section plane exactly on the boundary between two voxels is a common occurrence and is
 * intended to result in the display of the "next" (i.e. higher coordinate) plane rather than the
 * "previous" (lower coordinate) plane.  However, due to various sources of floating point
 * inaccuracy (in particular, shader code which has relaxed rules), values exactly on the boundary
 * between voxels may be slightly shifted in either direction.  To ensure that this doesn't result
 * in the display of the wrong data (i.e. the previous rather than next plane), we always shift
 * toward the "next" plane by this small amount.
 */
const CHUNK_POSITION_EPSILON = 1e-3;

export const glsl_getPositionWithinChunk = `
vec3 getPositionWithinChunk () {
  return floor(min(vChunkPosition, uChunkDataSize - 1.0));
}
`;


const tempMat4 = mat4.create();

class VolumeSliceVertexComputationManager extends BoundingBoxCrossSectionRenderHelper {
  static get(gl: GL) {
    return gl.memoize.get(
        'volume.VolumeSliceVertexComputationManager',
        () => new VolumeSliceVertexComputationManager(gl));
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);

    // A number in [0, 6) specifying which vertex to compute.
    builder.addAttribute('highp float', 'aVertexIndexFloat');

    // Specifies translation of the current chunk.
    builder.addUniform('highp vec3', 'uTranslation');

    // Matrix by which computed vertices will be transformed.
    builder.addUniform('highp mat4', 'uProjectionMatrix');

    // Chunk size in voxels.
    builder.addUniform('highp vec3', 'uChunkDataSize');

    // Size of a voxel in nanometers.
    builder.addUniform('highp vec3', 'uVoxelSize');

    builder.addUniform('highp vec3', 'uLowerClipBound');
    builder.addUniform('highp vec3', 'uUpperClipBound');

    // Position within chunk of vertex, in floating point range [0, chunkDataSize].
    builder.addVarying('highp vec3', 'vChunkPosition');

    builder.setVertexMain(`
vec3 chunkSize = uChunkDataSize * uVoxelSize;
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(chunkSize, uTranslation, uLowerClipBound, uUpperClipBound, int(aVertexIndexFloat));
gl_Position = uProjectionMatrix * vec4(position, 1.0);
vChunkPosition = (position - uTranslation) / uVoxelSize + ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);

    builder.addFragmentCode(glsl_getPositionWithinChunk);
  }

  computeVerticesDebug(
      uChunkDataSize: vec3, uVoxelSize: vec3, uLowerClipBound: vec3, uUpperClipBound: vec3,
      uPlaneDistance: number, uPlaneNormal: vec3, uTranslation: vec3, uProjectionMatrix: mat4) {
    let chunkSize = vec3.multiply(vec3.create(), uChunkDataSize, uVoxelSize);
    let gl_Position = vec3.create(), vChunkPosition = vec3.create(),
        planeNormalAbs = vec3.fromValues(
            Math.abs(uPlaneNormal[0]), Math.abs(uPlaneNormal[1]), Math.abs(uPlaneNormal[2]));
    for (let vertexIndex = 0; vertexIndex < 6; ++vertexIndex) {
      const position = this.computeVertexPositionDebug(
          chunkSize, uLowerClipBound, uUpperClipBound, uPlaneDistance, uPlaneNormal, uTranslation,
          vertexIndex);
      if (position === undefined) {
        console.log('no intersection found');
        return;
      }
      vec3.transformMat4(gl_Position, position, uProjectionMatrix);
      vec3.sub(vChunkPosition, position, uTranslation);
      vec3.divide(vChunkPosition, vChunkPosition, uVoxelSize);
      vec3.scaleAndAdd(vChunkPosition, vChunkPosition, planeNormalAbs, CHUNK_POSITION_EPSILON);
      console.log(`vertex ${vertexIndex}, at ${gl_Position}, vChunkPosition = ${vChunkPosition}`);
    }
  }

  beginSlice(_gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    this.data.outputVertexIndices.bindToVertexAttrib(aVertexIndexFloat, 1);
  }

  endSlice(gl: GL, shader: ShaderProgram) {
    let aVertexIndexFloat = shader.attribute('aVertexIndexFloat');
    gl.disableVertexAttribArray(aVertexIndexFloat);
  }

  beginSource(
      gl: GL, shader: ShaderProgram, sliceView: SliceView, dataToDeviceMatrix: mat4,
      spec: VolumeChunkSpecification, chunkLayout: ChunkLayout) {
    this.setViewportPlane(
        shader, sliceView.viewportAxes[2], sliceView.centerDataPosition, chunkLayout.invTransform);

    // Compute projection matrix that transforms chunk layout coordinates to device coordinates.
    gl.uniformMatrix4fv(
        shader.uniform('uProjectionMatrix'), false,
        mat4.multiply(tempMat4, dataToDeviceMatrix, chunkLayout.transform));

    gl.uniform3fv(shader.uniform('uVoxelSize'), spec.voxelSize);
    gl.uniform3fv(shader.uniform('uLowerClipBound'), spec.lowerClipBound);
    gl.uniform3fv(shader.uniform('uUpperClipBound'), spec.upperClipBound);
    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_uVoxelSize'] = spec.voxelSize;
      (<any>window)['debug_sliceView_uLowerClipBound'] = spec.lowerClipBound;
      (<any>window)['debug_sliceView_uUpperClipBound'] = spec.upperClipBound;
      (<any>window)['debug_sliceView'] = sliceView;
      (<any>window)['debug_sliceView_dataToDevice'] = dataToDeviceMatrix;
    }
  }

  setupChunkDataSize(gl: GL, shader: ShaderProgram, chunkDataSize: vec3) {
    gl.uniform3fv(shader.uniform('uChunkDataSize'), chunkDataSize);

    if (DEBUG_VERTICES) {
      (<any>window)['debug_sliceView_chunkDataSize'] = chunkDataSize;
    }
  }

  drawChunk(gl: GL, shader: ShaderProgram, chunkPosition: vec3) {
    gl.uniform3fv(shader.uniform('uTranslation'), chunkPosition);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);

    if (DEBUG_VERTICES) {
      let sliceView: SliceView = (<any>window)['debug_sliceView'];
      let chunkDataSize: vec3 = (<any>window)['debug_sliceView_chunkDataSize'];
      let voxelSize: vec3 = (<any>window)['debug_sliceView_uVoxelSize'];
      let lowerClipBound: vec3 = (<any>window)['debug_sliceView_uLowerClipBound'];
      let upperClipBound: vec3 = (<any>window)['debug_sliceView_uUpperClipBound'];
      console.log(
          `Drawing chunk: ${vec3Key(chunkPosition)} of data size ${vec3Key(chunkDataSize)}`);
      let dataToDeviceMatrix: mat4 = (<any>window)['debug_sliceView_dataToDevice'];
      this.computeVerticesDebug(
          chunkDataSize, voxelSize, lowerClipBound, upperClipBound,
          sliceView.viewportPlaneDistanceToOrigin, sliceView.viewportAxes[2], chunkPosition,
          dataToDeviceMatrix);
    }
  }
}

export interface RenderLayerOptions extends SliceViewRenderLayerOptions {
  sourceOptions: VolumeSourceOptions;
}

export class RenderLayer extends SliceViewRenderLayer {
  sources: VolumeChunkSource[][];
  vertexComputationManager: VolumeSliceVertexComputationManager;
  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource, options: Partial<RenderLayerOptions> = {}) {
    const {sourceOptions = {}} = options;
    super(multiscaleSource.chunkManager, multiscaleSource.getSources(sourceOptions), options);
    let gl = this.gl;
    this.vertexComputationManager = VolumeSliceVertexComputationManager.get(gl);
  }

  get dataType() {
    return this.sources![0][0].spec.dataType;
  }

  get chunkFormat() {
    return this.sources![0][0].chunkFormat;
  }

  getValueAt(position: vec3) {
    for (let alternatives of getTransformedSources(this)) {
      for (let transformedSource of alternatives) {
        const source = transformedSource.source as VolumeChunkSource;
        let result = source.getValueAt(position, transformedSource.chunkLayout);
        if (result != null) {
          return result;
        }
      }
    }
    return null;
  }

  getShader() {
    let key = this.getShaderKey() + '/' + this.chunkFormat.shaderKey;
    return this.gl.memoize.get(key, () => this.buildShader());
  }

  defineShader(builder: ShaderBuilder) {
    this.vertexComputationManager.defineShader(builder);
    builder.addFragmentCode(`
void emit(vec4 color) {
  gl_FragData[0] = color;
}
`);
    this.chunkFormat.defineShader(builder);
    builder.addFragmentCode(`
${getShaderType(this.dataType)} getDataValue() { return getDataValue(0); }
`);
  }

  beginSlice(_sliceView: SliceView) {
    let gl = this.gl;

    let shader = this.shader!;
    shader.bind();
    this.vertexComputationManager.beginSlice(gl, shader);
    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let gl = this.gl;
    this.vertexComputationManager.endSlice(gl, shader);
  }

  draw(sliceView: SliceView) {
    let visibleSources = sliceView.visibleLayers.get(this)!;
    if (visibleSources.length === 0) {
      return;
    }

    this.initializeShader();
    if (this.shader === undefined) {
      return;
    }

    let gl = this.gl;

    let chunkPosition = vec3.create();
    let shader = this.beginSlice(sliceView);
    let vertexComputationManager = this.vertexComputationManager;

    // All sources are required to have the same texture format.
    let chunkFormat = this.chunkFormat;
    chunkFormat.beginDrawing(gl, shader);

    for (let transformedSource of visibleSources) {
      const chunkLayout = transformedSource.chunkLayout;
      const source = transformedSource.source as VolumeChunkSource;
      const chunks = source.chunks;

      let originalChunkSize = chunkLayout.size;

      let chunkDataSize: vec3|undefined;
      let visibleChunks = sliceView.visibleChunks.get(chunkLayout);
      if (!visibleChunks) {
        continue;
      }

      vertexComputationManager.beginSource(
          gl, shader, sliceView, sliceView.dataToDevice, source.spec, chunkLayout);
      let sourceChunkFormat = source.chunkFormat;
      sourceChunkFormat.beginSource(gl, shader);

      let setChunkDataSize = (newChunkDataSize: vec3) => {
        chunkDataSize = newChunkDataSize;
        vertexComputationManager.setupChunkDataSize(gl, shader, chunkDataSize);
      };

      for (let key of visibleChunks) {
        let chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          let newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            setChunkDataSize(newChunkDataSize);
          }

          vec3.multiply(chunkPosition, originalChunkSize, chunk.chunkGridPosition);
          sourceChunkFormat.bindChunk(gl, shader, chunk);
          vertexComputationManager.drawChunk(gl, shader, chunkPosition);
        }
      }
    }
    chunkFormat.endDrawing(gl, shader);
    this.endSlice(shader);
  }
}
