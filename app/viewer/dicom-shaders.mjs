export const DICOM_VERTEX_SHADER = `
  out vec3 vOrigin;
  out vec3 vDirection;
  uniform vec3 uSize;
  uniform bool uOrthographic;
  void main() {
    vec3 cameraLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    vec3 texturePosition = position / uSize + 0.5;
    if (uOrthographic) {
      vec3 localView = normalize((inverse(modelViewMatrix) * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
      vec3 origin = position + localView * dot(cameraLocal - position, localView);
      vOrigin = origin / uSize + 0.5;
      vDirection = localView / uSize;
    } else {
      vOrigin = cameraLocal / uSize + 0.5;
      vDirection = texturePosition - vOrigin;
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const DICOM_FRAGMENT_SHADER = `
  precision highp float;
  precision highp sampler3D;
  in vec3 vOrigin;
  in vec3 vDirection;
  out vec4 outColor;
  uniform sampler3D uVolume;
  uniform vec3 uSize;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  void writeSampleDepth(vec3 texturePoint) {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4((texturePoint - 0.5) * uSize, 1.0);
    gl_FragDepth = clamp((clip.z / clip.w) * 0.5 + 0.5, 0.0, 1.0);
  }
  uniform float uDensityLow;
  uniform float uDensityHigh;
  uniform float uOpacity;
  uniform float uCropMin;
  uniform float uCropMax;
  uniform float uStep;
  uniform float uInteractive;
  uniform float uViewMode;
  uniform vec3 uVoxel;

  vec2 hitBox(vec3 origin, vec3 direction) {
    vec3 invDirection = 1.0 / direction;
    vec3 tMin = (vec3(0.0) - origin) * invDirection;
    vec3 tMax = (vec3(1.0) - origin) * invDirection;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
  }

  vec3 densityGradient(vec3 point) {
    return vec3(
      texture(uVolume, point + vec3(uVoxel.x, 0.0, 0.0)).r - texture(uVolume, point - vec3(uVoxel.x, 0.0, 0.0)).r,
      texture(uVolume, point + vec3(0.0, uVoxel.y, 0.0)).r - texture(uVolume, point - vec3(0.0, uVoxel.y, 0.0)).r,
      texture(uVolume, point + vec3(0.0, 0.0, uVoxel.z)).r - texture(uVolume, point - vec3(0.0, 0.0, uVoxel.z)).r
    );
  }

  void main() {
    vec3 direction = normalize(vDirection);
    vec2 bounds = hitBox(vOrigin, direction);
    if (bounds.x > bounds.y) discard;
    bounds.x = max(bounds.x, 0.0);
    vec3 point = vOrigin + bounds.x * direction;
    float distanceTravelled = bounds.x;
    vec4 accumulated = vec4(0.0);
    vec3 firstVisiblePoint = point;
    bool hasVisiblePoint = false;
    float low = clamp((uDensityLow - -1024.0) / 4095.0, 0.0, 0.998);
    float high = clamp((uDensityHigh - -1024.0) / 4095.0, low + 0.002, 1.0);
    float isoLevel = mix(low, high, 0.16);
    float previousDensity = 0.0;
    vec3 previousPoint = point;

    for (int i = 0; i < 1024; i++) {
      if (distanceTravelled > bounds.y || (uInteractive > 0.5 && accumulated.a > 0.985)) break;
      if (point.z >= uCropMin && point.z <= uCropMax) {
        float density = texture(uVolume, point).r;
        if (uInteractive < 0.5 && uViewMode > 0.5) {
          if (density >= isoLevel && previousDensity < isoLevel) {
            vec3 lowerPoint = previousPoint;
            vec3 upperPoint = point;
            for (int refinement = 0; refinement < 5; refinement++) {
              vec3 middlePoint = mix(lowerPoint, upperPoint, 0.5);
              if (texture(uVolume, middlePoint).r >= isoLevel) upperPoint = middlePoint;
              else lowerPoint = middlePoint;
            }
            vec3 surfacePoint = mix(lowerPoint, upperPoint, 0.5);
            float surfaceDensity = texture(uVolume, surfacePoint).r;
            vec3 normal = normalize(-densityGradient(surfacePoint) + vec3(0.00001));
            vec3 viewDirection = normalize(-direction);
            if (dot(normal, viewDirection) < 0.0) normal = -normal;
            vec3 keyDirection = normalize(viewDirection + vec3(0.42, 0.58, 0.72));
            vec3 halfDirection = normalize(keyDirection + viewDirection);
            float diffuse = max(dot(normal, keyDirection), 0.0);
            float fill = max(dot(normal, viewDirection), 0.0);
            float rim = pow(1.0 - fill, 2.0);
            float specular = pow(max(dot(normal, halfDirection), 0.0), 30.0);
            float surfaceTone = smoothstep(isoLevel, max(isoLevel + 0.02, high), surfaceDensity);
            // Muted warm grey for the solid surface; density data and thresholds stay unchanged.
            vec3 boneColor = mix(vec3(0.56, 0.55, 0.51), vec3(0.77, 0.76, 0.70), surfaceTone);
            vec3 color = boneColor * (0.34 + diffuse * 0.72 + fill * 0.16 + rim * 0.08);
            color += vec3(0.92, 0.92, 0.88) * specular * 0.15;
            writeSampleDepth(surfacePoint);
            outColor = vec4(color, clamp(uOpacity * 1.2, 0.08, 1.0));
            return;
          }
        } else {
          float transfer = smoothstep(low, high, density);
          float alpha = pow(transfer, 1.35) * uOpacity * (uInteractive > 0.5 ? 0.06 : 0.09);
          if (alpha > 0.002) {
            if (!hasVisiblePoint) { firstVisiblePoint = point; hasVisiblePoint = true; }
            vec3 boneColor = mix(vec3(0.72, 0.61, 0.43), vec3(1.0, 0.97, 0.86), transfer);
            float shade = 0.78;
            if (uInteractive < 0.5) {
              vec3 gradient = densityGradient(point);
              vec3 normal = normalize(gradient + vec3(0.0001));
              float diffuse = abs(dot(normal, normalize(vec3(0.45, 0.65, 1.0))));
              float facing = abs(dot(normal, -direction));
              float specular = pow(max(facing, 0.0), 22.0);
              float edgeStrength = clamp(length(gradient) * 16.0, 0.0, 1.0);
              shade = 0.34 + diffuse * 0.56 + specular * 0.34;
              alpha *= 0.62 + edgeStrength * 0.9;
            }
            accumulated.rgb += (1.0 - accumulated.a) * alpha * boneColor * shade;
            accumulated.a += (1.0 - accumulated.a) * alpha;
          }
        }
        previousDensity = density;
        previousPoint = point;
      } else {
        previousDensity = 0.0;
        previousPoint = point;
      }
      point += direction * uStep;
      distanceTravelled += uStep;
    }
    if (uInteractive < 0.5 && uViewMode > 0.5) discard;
    if (accumulated.a < 0.01) discard;
    writeSampleDepth(firstVisiblePoint);
    outColor = vec4(accumulated.rgb / max(accumulated.a, 0.0001), accumulated.a);
  }
`

