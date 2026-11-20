# Gallery vehicle host API

Contract: `atlantis-gallery-vehicle/1`. Rendering is exclusively owned by Gallery. Both modes use one Viewer, canvas, scene renderer, physical camera pipeline, lighting, effects and 2048-square shadow map. Controllers must not construct Viewer, GPU, Renderer, effects or their own iframe. Renderer updates apply to both modes.

Submission descriptor:
```json
{"schema":"atlantis-gallery-vehicle/1","renderer":"gallery-shared","thirdPersonCursor":"hidden","base":"./drive/","module":"controller.js","assets":{"course":"Course.glb"}}
```
`base` is relative to the model; module/assets are relative to base. Explicitly include the full dependency closure in previewFiles and controlFiles/motionFiles. Built-in profiles `t10` and `ember-29` are available instead of module; Tiger II retains its native Python profile. HTML vehicleEntry is retired for new publication.

The JavaScript module exports `async install({viewer, root, read, base, output, help, mode, loadAssets})`. `root` is the existing inspection model hierarchy (THREE source transforms are synchronized into the native render tree). `read(path)` fetches JSON from base. `await loadAssets()` returns the extra course/effect roots loaded by the host. Do not instantiate another renderer or replace beforeRender. Return `{input:{release()}, setMode(enabled), reset(), update(dt), focus(), dispose()}`. `focus()` returns the current vehicle center in Y-up world coordinates or null before its first snapshot. The host selects a vehicle-sized stable shadow footprint, never the course bounds. Use the existing camera and controls API; all lighting and effects remain shared.

The host provides a Start / Inspect button, pointer lock, cursor:none fallback (including denied pointer lock), Esc/blur/hidden-tab/capture-loss release and cleanup. Do not show a custom/menu pointer in active third person; exit to inspection to use menus. Clear held input and mouse buttons on release; prevent held keys from leaking across entry. Python runs in the common Pyodide worker with fixed substeps; dependency modules can be supplied as `{dependencies:{"core.py":URL}}`. Keep native PhysX separate.

Validation: actual keyboard/mouse movement, braking/settling and linked parts; a single canvas, no iframe or external navigation; identical Viewer, scene renderer, pipeline, lighting and effects objects before/during/after operation; cursor hidden with capture available and denied, restored after Esc/blur; 2048 shadow map with bounded moving domain (not the whole ground). Include the updated adapter and this contract in controls.zip and update both assembly documents.
