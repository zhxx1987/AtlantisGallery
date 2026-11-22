import { installRendererControls } from '../atlantis-renderer/frontend/webgpu/renderer_controls.js';

const groups = ['lighting', 'clouds', 'exposure', 'ssao', 'fog', 'glow', 'shafts', 'shadows', 'antialiasing', 'shader-bevel'];
const labels = {
  weatherPreset: 'Sky preset', custom: 'Current / Custom', clear: 'Clear', overcast: 'Overcast', sunset: 'Sunset',
  sliderSuffix: ' slider', componentSuffix: ' component ',
  lightingGroup: 'Lighting and sky', environmentYaw: 'Environment yaw (°)', timeOfDay: 'Solar time',
  directEnabled: 'Direct sunlight', displaySun: 'Solar disc', aerialEnabled: 'Aerial perspective',
  iblIntensity: 'Sky IBL intensity', sunDirection: 'Sun direction', solarIrradiance: 'Solar irradiance (RGB)',
  turbidity: 'Turbidity', rayleigh: 'Rayleigh scattering', mie: 'Mie scattering',
  cloudsGroup: 'Clouds', cloudCoverage: 'Coverage', cloudDensity: 'Density', cloudAltitude: 'Base altitude (m)',
  cloudThickness: 'Thickness (m)', cloudSeed: 'Seed', animateClouds: 'Animate clouds', cloudTime: 'Cloud time (s)',
  exposureGroup: 'Exposure', autoExposure: 'Auto exposure', exposureCompensation: 'Compensation (EV)',
  aperture: 'Aperture', shutter: 'Shutter (s)', minEV: 'Minimum EV', maxEV: 'Maximum EV',
  adaptationUp: 'Brighten speed', adaptationDown: 'Darken speed', radianceScale: 'Radiance scale',
  ssaoGroup: 'SSAO', ssao: 'Enable SSAO', ssaoRadius: 'Radius (m)', ssaoIntensity: 'Intensity', ssaoBias: 'Bias (m)',
  fogGroup: 'Height fog', fog: 'Enable height fog', fogVolumetric: 'Volume scattering',
  fogShadows: 'Volume shadows', fogSteps: 'Volume samples', fogAnisotropy: 'Forward scattering',
  fogSunIntensity: 'Sun scatter intensity', fogAmbientIntensity: 'Ambient scatter intensity', fogDensity: 'Density (/m)',
  fogColor: 'Fog color (linear RGB)', fogBaseHeight: 'Base height (m)', fogHeightFalloff: 'Height falloff (/m)',
  fogStart: 'Start distance (m)', fogMaxDistance: 'Maximum distance (m)', fogMaxOpacity: 'Maximum opacity',
  glowGroup: 'Glow and Bloom', bloomThreshold: 'Bloom threshold', bloomMaxBrightness: 'Bloom brightness limit',
  shaftsGroup: 'Light Shaft', lightShafts: 'Shaft intensity', lightShaftOcclusion: 'Depth occlusion',
  lightShaftBloom: 'Shaft Bloom', lightShaftDensity: 'Density', lightShaftDecay: 'Decay', lightShaftSamples: 'Samples',
  lightShaftOcclusionDepthRange: 'Occlusion depth (m)', lightShaftOcclusionMaskDarkness: 'Occlusion darkness',
  lightShaftBloomScale: 'Bloom scale', lightShaftBloomThreshold: 'Bloom threshold',
  lightShaftBloomAngularRadius: 'Angular radius (°)', lightShaftBloomTint: 'Bloom tint (RGB)',
  lightShaftOverrideDirection: 'Direction override (zero uses sun)',
  shadowsGroup: 'Cascaded Shadows', enabled: 'Enable cascaded shadows',
  shadowMapSize: 'Resolution per cascade',
  shadowCoverageNote: '{count} world-space cascades with scene-adaptive coverage',
  antialiasingGroup: 'Antialiasing', 'shader-bevelGroup': 'Shader Bevel', shaderBevel: 'Enable shader bevel',
  shaderBevelRadius: 'Radius (m)', shaderBevelStrength: 'Strength',
};

export function mountGalleryRendererControls(viewer, container, status) {
  return installRendererControls(viewer, container, {
    includeGroups: groups, labels,
    onError: error => { status.textContent = error.message; },
    onChange: () => { status.textContent = ''; },
  });
}
