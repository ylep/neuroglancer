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

export type RelativeDragHandler = (event: MouseEvent, deltaX: number, deltaY: number) => void;
export function startRelativeMouseDrag(
    initialEvent: MouseEvent, handler: RelativeDragHandler,
    finishDragHandler?: RelativeDragHandler) {
  let {document} = initialEvent.view;
  let prevScreenX = initialEvent.clientX, prevScreenY = initialEvent.clientY;
  let mouseMoveHandler = (e: MouseEvent) => {
    let deltaX = prevScreenX - e.clientX;
    let deltaY = prevScreenY - e.clientY;
    prevScreenX = e.clientX;
    prevScreenY = e.clientY;
    handler(e, deltaX, deltaY);
  };
  let button = initialEvent.button;
  let mouseUpHandler = (e: MouseEvent) => {
    if (e.button === button) {
      document.removeEventListener('mousemove', mouseMoveHandler, true);
      document.removeEventListener('mouseup', mouseUpHandler, false);

      if (finishDragHandler !== undefined) {
        finishDragHandler(e, prevScreenX - e.clientX, prevScreenY - e.clientY);
      }
    }
  };
  document.addEventListener('mousemove', mouseMoveHandler, true);
  document.addEventListener('mouseup', mouseUpHandler, false);
}
