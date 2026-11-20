# Atlantis Gallery

https://zhxx1987.github.io/AtlantisGallery/
The gallery shows 12 works per page. Each work page shows the creator and provides a copyable link, file downloads, and 3D controls. Relative URLs support both local preview and GitHub Pages project sites.

## Run locally and deploy

Run `python publisher/serve.py 8080` from this directory and open `http://localhost:8080/`. The 3D viewer requires a browser with WebGPU support and a secure context. Localhost works for local previews. Three.js 0.186.0 ships with the site. Works that use Python load Pyodide 0.27.7 from jsDelivr on first use.

Commit the project directory to a public GitHub repository. Under Settings → Pages, select the main branch and the repository root. Work links use `work.html?model=<id>` and gallery pagination uses `?page=2`. Existing work links to the gallery home redirect to the detail page.

## Work data

Add each new work to its own `_data/works/<asset-id>.json` with `id`, `title`, `creator`, `thumbnail`, `model`, and optional `description`, `interaction`, and `downloads` fields. Write titles, descriptions, download labels, and interaction labels in English. Use the creator's chosen display name. Set `packageLayout: "model-controls-source/1"` with exactly three downloads of `kind` model, controls, modeling-source. Include external USD references and textures with their relative paths intact, or use USDZ.

Each work links to its GitHub discussion for upvotes and comments and to a gist for favorites. Visitors can find their saved assets under GitHub's **Starred gists** while signed in.

The owner’s MCP publisher creates both links for direct uploads. After merging a contributor’s pull request or adding a work by hand, run `python publisher/server.py --sync-social` from the Gallery checkout with the publisher dependencies installed and the Gallery owner's GitHub account signed in through Git Credential Manager. Commit and push the updated `social.json`. The command reuses links it created on any previous attempt.

Interaction files support the `atlantis-gallery-interactions/2` schema. Use full prim paths or unique names to bind parts. Define rotation and translation axes in local coordinates. Rotation uses radians and translation uses model units. Each button can bind a 3D part and trigger multiple actions. It also appears in the page controls.

```json
{
  "schema": "atlantis-gallery-interactions/2",
  "normalCreaseDegrees": 45,
  "joints": [
    { "id": "door", "node": "/Asset/Hinge", "kind": "rotation", "axis": [0, 1, 0], "limits": [0, 1.65] },
    { "id": "tray", "node": "/Asset/Tray", "kind": "spin", "axis": [0, 1, 0] }
  ],
  "buttons": [
    {
      "id": "open",
      "node": "/Asset/OpenButton",
      "label": "Open Door",
      "actions": [
        { "type": "set", "joint": "door", "value": 1.65 },
        { "type": "spin", "joint": "tray", "value": 0 },
        { "type": "emit", "event": "opened" }
      ]
    }
  ]
}
```

An `emit` action dispatches `atlantis:emit` on the model root and can pass input to the `logic.profile` declared in the interaction file. The built-in `microwave` profile runs the shared Isaac `microwave_logic.py` in a Web Worker. `logic.bindings` maps returned state to joint position, spin speed, or part visibility. Other devices can use declarative actions or a pure Python module and browser adapter added to the site. Isaac's PhysX constraints, `omni` and `pxr` runtime, and simulator lighting APIs run in the Isaac process.

## 3D import and rendering

Three.js imports USD, USDA, USDC, USDZ, and GLB/glTF while preserving the part hierarchy for interactions and picking. The importer splits and smooths normals at each mesh's face corners. The default crease angle is 45° and can be adjusted with `normalCreaseDegrees`. The USD path uses the original topology to identify smoothing regions and preserves face-varying, uniform, and constant normals. It smooths across UV seams while retaining UVs, material groups, and other vertex attributes.

`atlantis-renderer/` comes from the local Atlantis C `current/rendering` directory and reuses its sky, clouds, atmosphere, skylight, preintegrated IBL, direct sunlight, Disney Principled shading, glow, and bloom. The viewer uses a single 2048 × 2048 shadow map that updates with model pose, screen-space reflections for opaque objects, and FXAA. Imported geometry and materials are staged as an in-memory GLB. Downloads use the original files. For complex USD composition, certain material networks, and PhysX, the exporter needs to provide a browser-ready preview and interaction mapping.

## Atlantis sharing integration

Use the [Share a Model guide](https://zhxx1987.github.io/AtlantisGallery/publish.html). The updated Atlantis client bundles the publisher and exposes atlantis_gallery_prepare and atlantis_gallery_publish; no separate MCP is required. The optional standalone publisher keeps prepare_gallery_upload and publish_gallery_asset. Update an existing standalone checkout using git pull --ff-only and restart its MCP.

The creator's public atlantis-<slug> repository hosts immutable previews on GitHub Pages and complete downloads on GitHub Releases. The main Gallery receives only an index entry and thumbnail (at most 1 MiB). Existing hosted works keep their URLs. Contributors submit pull requests; the Gallery owner publishes directly. Interrupted uploads resume using the same approved plan. Pages access, CORS and preview hashes must pass before indexing.

Explicitly listed files and the publisher's baseline assembly instructions are packaged. The plan lists each public file, archive member, hash and destination. Publication requires the creator-approved digest and confirm_public=true. A changed package requires a new review. Preview files must each be smaller than 100 MiB, total at most 900 MiB; each Release asset must be smaller than 2 GiB.

The publisher builds `model.zip` (assets and dependencies), `controls.zip` (all supplied game and real-physics operation code, host adapters, configuration and assembly instructions), and `modeling-code.zip` (all editable part sources/rebuild inputs and optional approved work-order JSON). `motionFiles` and `controlFiles` go into controls; preview code is copied there automatically. List non-code controller dependencies explicitly in controlFiles. Model and controls extract into the same directory without member collisions. Modeling source extracts separately. Updates replace the work's current three links rather than adding motion or work-order buttons. Shared Isaac and Unreal/Unity/Godot assembly actions explain these roles and use the selected runtime. Advertise Isaac modes via `isaacRuntimes` only when their `isaac-runtimes.json` entry and USD are actually packaged.

Simplified ground vehicles default to braking/coasting/hold, stop-before-reverse, contact traction, bounded per-wheel spring/damper suspension, terrain pitch/roll, a mild braking dip that settles, airborne/landing response and actual wheel/arm/track linkage. Test fixed-step Python in Pyodide and actual Gallery keyboard input with visible transforms. Real physics is independent; never double-integrate a native rigid body with procedural suspension.

Before preparing the upload, convert all user-visible model interaction text to English in the Gallery copy: buttons, menus, fields, hints, keyboard/mouse help, tooltips, statuses, runtime messages and vehicle/viewport mode controls. Check interaction.json, Python/browser scripts and visible model operating text. Keep the creator's name, prim paths, joint/event IDs, binding keys, mappings and behavior. Operate the actual browser preview and verify English text and linked controls. Documentation and private conversations can remain in their original language.

Atlantis updates distribute the publisher, sharing rules and public usage skill together. The WebGPU sharing button opens the guide; it does not itself upload files. Existing work downloads and social links remain supported.

Read the live sharing guide with `atlantis_gallery_requirements` (standalone: `read_gallery_requirements`). Supply its `requirements_digest` to prepare and publish. Declare `operableVehicle` in submission.json. An operable vehicle must run inside the Gallery work page using its native controls or a packaged HTML `vehicleEntry`.

Pages builds entries.json from the individual work records. The viewer also reads catalog.json for older works. To convert a clean older PR that only added records, fetch the target main branch, then run `python /path/to/updated/publisher/migrate_submission.py upstream/main` from the PR checkout. Add `--apply` to move its additions into individual files. Review and commit the migration, then merge upstream/main normally. Changed existing records or duplicate IDs need individual review.
