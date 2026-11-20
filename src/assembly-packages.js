// One contract shared by work-page Isaac prompts and every engine work order.
export function packagePlan(item) {
  return (item.downloads || []).map(file => ({
    role: file.kind || 'published-download', label: file.label,
    url: new URL(file.url, location.href).href,
  }));
}

export function packageInstructions(item) {
  if (item.packageLayout !== 'model-controls-source/1') return [
    'Inspect all published downloads and their launch instructions. Preserve relative paths when extracting model assets and operation scripts into a dedicated directory.',
  ];
  return [
    'There are exactly three current downloads: model assets, combined controls (simplified game and native real physics when supplied), and editable modeling source. Use the current links below; do not retrieve older separate motion archives.',
    'Extract the MODEL and CONTROLS archives into the SAME dedicated directory, preserving their relative paths. Model assets alone do not enable driving. For an existing installation, close its running controller and replace the old files with the current packages; use a fresh directory if its layout differs.',
    'The MODELING SOURCE archive is for rebuilding or editing geometry. Extract it into a separate source directory and read its rebuild instructions; it is not required to drive the exported model.',
    'Read ASSEMBLE_ISAAC.md, ASSEMBLE_GAME_ENGINE.md and isaac-runtimes.json in the combined controls package. Resolve the selected entry point against the model files before launching. Keep exactly one driving controller active per vehicle instance.',
  ];
}

export function isVehicle(item, spec) {
  return !!(item.operableVehicle || item.vehicleEntry || item.isaacRuntimes || spec?.logic?.profile === 'vehicle');
}

export const vehicleDynamics = [
  'Simplified ground-vehicle driving must include acceleration, coasting, active braking and parking hold, stop-before-reverse, ground-contact traction, bounded per-wheel spring/damper suspension, terrain-aligned body pitch/roll, mild hard-brake nose dip with damped settling, no airborne traction and landing response.',
  'Bind road wheels, suspension arms and the closed track path to the actual model pivots and travelled distance. Preserve authored controls and a third-person driving camera. Use a fixed simulation timestep with a persistent accumulator and release input safely on lost focus.',
  'Native real physics uses its own engine solver and controller. Never superimpose the simplified suspension or procedural body integration on a vehicle already driven by native rigid-body physics. Native Isaac PhysX code requires Isaac Sim; it is not executable browser physics.',
];

export const vehicleAcceptance = [
  'Exercise real keyboard/mouse input: start, coast, hard brake to hold with a mild nose dip that settles, stop-before-reverse, differential steering, a one-sided bump, slope, airborne landing and loss-of-focus input release. Check stability at 30/60/144 render FPS with a fixed simulation step.',
  'Observe actual wheel/arm/track transforms and visible terrain contact. Report the selected runtime, exact files, engine version and measured results; identify untested native physics behavior explicitly.',
];
