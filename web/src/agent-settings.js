// LLM configuration for the agent FAB. Adapted from Patapsco's
// platform-agent-panel settings shape MINUS the `deployed-stack` provider
// (in-cluster gateway, not relevant to Foyer today).
//
// Two provider kinds:
//   - webllm   — browser-local via WebLLM; no network; big first-load
//   - external — OpenAI-compatible endpoint (OpenAI/Anthropic proxy/Ollama)
//
// Settings live in localStorage so they survive reload and don't involve the
// foyer-server. The MCP wiring (M8) reads whatever is active here.

const STORAGE_KEY = "foyer.agent.settings.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  kind: "external",
  // WebLLM
  webllmModel: "Llama-3.1-8B-Instruct-q4f32_1-MLC",
  webllmContextSize: 16384,
  // External
  externalEndpoint: "https://api.anthropic.com/v1",
  externalApiKey: "",
  externalModel: "claude-sonnet-4-6",
});

/// Representative WebLLM catalog. Real WebLLM has dozens; these are the ones
/// most likely to be useful for a DAW copilot (small, instruction-tuned,
/// reasonable on an M-series laptop).
export const WEBLLM_MODELS = [
  { id: "Llama-3.2-3B-Instruct-q4f32_1-MLC", label: "Llama 3.2 3B", sizeGB: 2.0 },
  { id: "Llama-3.1-8B-Instruct-q4f32_1-MLC", label: "Llama 3.1 8B", sizeGB: 4.6 },
  { id: "Qwen2.5-7B-Instruct-q4f32_1-MLC",   label: "Qwen 2.5 7B",   sizeGB: 4.1 },
  { id: "Phi-3.5-mini-instruct-q4f32_1-MLC", label: "Phi 3.5 mini",   sizeGB: 2.2 },
];

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}
