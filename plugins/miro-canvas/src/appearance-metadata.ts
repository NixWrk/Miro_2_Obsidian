/**
 * Stable metadata-facing appearance API.
 *
 * The implementation lives in `appearance.ts` so the reducer and the merge
 * boundary share one set of canonical types.  This small module gives UI and
 * persistence adapters a focused import path without creating a second model.
 */
export {
  mergeAppearanceIntoMetadata,
  mergeAppearanceMetadata,
  toAppearanceMetadata,
  appearanceToMetadata,
  fromAppearanceMetadata,
  normalizeAppearance,
  normalizeAppearanceState,
  validateAppearance,
  validateAppearanceState,
  type AppearanceMetadataPayload,
  type AppearanceState,
} from "./appearance";
