// WebGL helpers shared by the viz components.
//
// All viz components that want GPU rendering should go through these
// helpers so the error handling + extension hunt stays in one place.
// Falls back gracefully when WebGL2 isn't available — callers decide
// whether to drop back to a Canvas 2D path or simply skip rendering.

/** Grab a WebGL2 context on the given canvas, or `null` if unavailable.
 *  We use WebGL2 (not 1) because float textures + `texImage2D` with
 *  `RED`/`R32F` are standardized; WebGL1 would need
 *  `OES_texture_float` + `WEBGL_color_buffer_float` extensions that
 *  aren't universally shipped. */
export function tryGl2(canvas) {
  try {
    // `antialias: false` keeps the triangle-strip edges pixel-crisp.
    // With antialias on (MSAA), the GPU blends partially-covered
    // fragments at polygon edges — which looked like a "glow" around
    // every waveform bucket. For a sample-accurate waveform display
    // we want hard edges.
    return canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
  } catch {
    return null;
  }
}

/** Compile a shader + throw with the GL info log on failure. */
export function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(
      `shader compile failed (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"}):\n${log}`,
    );
  }
  return sh;
}

/** Link a program from vertex + fragment source, or throw. */
export function linkProgram(gl, vertSrc, fragSrc) {
  const v = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed:\n${log}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}

/** Create a fullscreen quad VAO with `a_uv` (0..1). Returns {vao, dispose}. */
export function createQuad(gl, program) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // Two triangles covering clip-space [-1, 1] × [-1, 1]. Each vertex
  // carries its UV in 0..1 so the fragment shader can sample the
  // peaks texture positionally.
  // prettier-ignore
  const data = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
    -1,  1, 0, 1,
     1, -1, 1, 0,
     1,  1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, "a_pos");
  const uvLoc  = gl.getAttribLocation(program, "a_uv");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

  gl.bindVertexArray(null);
  return {
    vao,
    dispose() {
      gl.deleteBuffer(buf);
      gl.deleteVertexArray(vao);
    },
  };
}

/** Upload a `Float32Array` of interleaved `(min, max)` peaks as a
 *  2-channel RG32F texture with `bucket_count` texels. The shader
 *  samples this with clamp-to-edge + (ideally) linear filtering so the
 *  waveform smooth-interpolates between buckets at high zoom (instead
 *  of the nearest-neighbor stair-step we had before).
 *
 *  LINEAR filtering of float textures requires `OES_texture_float_linear`
 *  — on drivers without that extension, setting `gl.LINEAR` silently
 *  returns nothing sampled (the waveform renders as empty/flat). We
 *  probe once, cache the result on the GL context, and fall back to
 *  NEAREST when the extension is missing. Slight stair-step loss vs.
 *  the dead-wave we had before is a very good trade. */
export function uploadPeaksTexture(gl, peaks) {
  if (!peaks || !peaks.peaks || !peaks.peaks.length || !peaks.bucket_count) {
    return null;
  }
  if (gl._foyerLinearFloatChecked === undefined) {
    gl._foyerLinearFloatChecked = true;
    gl._foyerLinearFloat = !!gl.getExtension("OES_texture_float_linear");
    gl._foyerMaxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    // eslint-disable-next-line no-console
    console.info(
      `[foyer-viz] GL2 initialized; float-linear=${gl._foyerLinearFloat}; max_tex=${gl._foyerMaxTex}`,
    );
  }
  const filter = gl._foyerLinearFloat ? gl.LINEAR : gl.NEAREST;
  const maxTex = gl._foyerMaxTex;

  // Finer tiers + long regions can produce more buckets than the GPU
  // will accept as a 1D texture (MAX_TEXTURE_SIZE is 4096 on a lot of
  // integrated GPUs, 16384 on desktop). Downsample on the CPU —
  // min/max aggregation preserves the waveform envelope perfectly for
  // our purposes (we never draw beyond the viewport's pixel width
  // anyway, so a few thousand buckets is ample).
  let buckets = peaks.bucket_count | 0;
  let source = peaks.peaks;
  if (buckets > maxTex) {
    const stride = Math.ceil(buckets / maxTex);
    const newBuckets = Math.ceil(buckets / stride);
    const packed = new Float32Array(newBuckets * 2);
    for (let i = 0; i < newBuckets; i++) {
      let lo = Infinity, hi = -Infinity;
      const start = i * stride;
      const end = Math.min(buckets, start + stride);
      for (let j = start; j < end; j++) {
        const a = source[j * 2];
        const b = source[j * 2 + 1];
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      packed[i * 2] = Number.isFinite(lo) ? lo : 0;
      packed[i * 2 + 1] = Number.isFinite(hi) ? hi : 0;
    }
    source = packed;
    buckets = newBuckets;
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  // Pack interleaved (min, max) into an RG32F texture of width = buckets,
  // height = 1.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RG32F,
    buckets,
    1,
    0,
    gl.RG,
    gl.FLOAT,
    source instanceof Float32Array ? source : new Float32Array(source),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return { tex, buckets };
}
