export const POINT_VERTEX_SHADER = /* glsl */ `
  attribute float aBrightness;
  uniform float uPointSize;
  varying float vBrightness;
  void main() {
    vBrightness = aBrightness;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPointSize * (18.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const POINT_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vBrightness;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.0, d);
    alpha *= uOpacity * vBrightness;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`
