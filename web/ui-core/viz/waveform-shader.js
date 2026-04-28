// Waveform shaders — vertex-based, triangle strip. Each bucket
// contributes two vertices (top = max envelope, bottom = min
// envelope). Drawing as GL_TRIANGLE_STRIP paints a continuous
// filled polygon — sample-accurate at any zoom, no texture sample,
// no bilinear smear.
//
// The strip is **never** broken: silent buckets collapse to a
// zero-height band at the midline but the triangle between them and
// the next loud bucket still spans, so you see a smooth envelope
// curve rather than discrete lozenges with gaps.

export const VERT = `#version 300 es
in float a_ix;
in float a_value;
in float a_side;
out float v_amp;

void main() {
    float x = a_ix * 2.0 - 1.0;
    // WebGL clip space: +Y is up. Positive sample values should draw
    // above the midline → positive Y. Flip Canvas-coordinate
    // intuitions here.
    float y = a_value;
    gl_Position = vec4(x, y, 0.0, 1.0);
    v_amp = abs(a_side);
}
`;

export const FRAG = `#version 300 es
precision highp float;
in float v_amp;
out vec4 fragColor;
uniform vec4 u_fill;
void main() {
    fragColor = u_fill;
}
`;

// Clip marker pass: same VBO, drawn as GL_LINES between the
// (top, bottom) vertex pair for buckets that breached the clip
// threshold. No separate shader needed — we reuse FILL_* with a
// different u_fill uniform.
