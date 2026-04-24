// foyer-core public entry — a barrel over the bits third parties + UI
// packages actually import. Keep this narrow so we can refactor
// internals without breaking consumers.
export { MANIFEST } from "./package.js";
export { bootFoyerCore, mountVariant, unmountVariant } from "./bootstrap.js";
export { Store } from "./store.js";
export { FoyerWs } from "./ws.js";

// Registries — both the UI and consumers that bring their own
// backend translation call these.
export {
  registerUiVariant,
  listUiVariants,
  getUiVariant,
  pickUiVariant,
  sniffEnv,
  setUserVariantPreference,
  getUserVariantPreference,
} from "./registry/ui-variants.js";

export {
  setFeatures,
  featureEnabled,
  featureState,
  showFeature,
  featureSnapshot,
  onFeatureChange,
} from "./registry/features.js";

export {
  registerWidget,
  widgetTag,
  setActiveVariant,
  setVariantParent,
  widgetSnapshot,
} from "./registry/widgets.js";

// RBAC helpers (thin wrapper around store.isAllowed — UI uses these
// directly to gate controls without null-checking the store).
export { isAllowed, isActionAllowed, onRbacChange } from "./rbac.js";
