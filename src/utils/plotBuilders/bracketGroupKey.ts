/**
 * Mojibake repair and canonical key utilities for bracket group matching.
 *
 * Root cause of the bracket-rendering bug:
 *   Python backend may return pairwise_comparisons group1/group2 with UTF-8
 *   bytes misread as Latin-1 ("Temp_30(Â°C)" instead of "Temp_30(°C)").
 *   The x-axis category names are decoded correctly by the frontend.
 *   The mismatch causes bracket→category lookup to fail silently.
 *
 * Two exports:
 *   repairMojibakeForDisplay — repair only, preserves original case.
 *                              Use for display text (effectLabel, UI labels).
 *   canonicalizeBracketGroupKey — repair + lowercase (no NFKD fold).
 *                              Use on BOTH sides of bracket↔category key lookup.
 *
 * Repair strategy (three layers):
 *   1. NFC normalization — collapses composed/decomposed Unicode forms.
 *   2. Targeted repair — most common sequence documented for clarity:
 *        Â° → °  (degree sign U+00B0; UTF-8 0xC2 0xB0 misread as Latin-1)
 *   3. Guarded generic recovery — any remaining (Â/Ã) + continuation byte
 *      (U+0080–U+00BF) pattern is reconstructed as its original code point.
 *      This covers the full 2-byte UTF-8 range U+0080–U+07FF without touching
 *      valid ASCII or genuine Latin-1 text.
 *      Note: Ã+NBSP (U+00C3 U+00A0) → à (U+00E0), NOT Ã+space (U+0020),
 *      which is why a targeted "/Ã /g" regex with a plain space is wrong.
 *
 * Adding new targeted repairs: only needed as documentation — the generic
 * layer handles all 2-byte cases.  Add a comment + test if you want to call
 * out a specific character.
 */

/**
 * Repair UTF-8-as-Latin-1 mojibake in text, preserving original case.
 * Safe for use in display labels (effectLabel, sidebar, etc.).
 */
export function repairMojibakeForDisplay(value: string): string {
  return (
    value
      // Layer 1: NFC normalization
      .normalize('NFC')
      // Layer 2: targeted repair — degree sign (most common; documented)
      //   U+00B0 ° → UTF-8 0xC2 0xB0 → Latin-1 "Â°"
      .replace(/Â°/g, '°')
      // Layer 3: guarded generic recovery
      //   Matches any (Â = U+00C2 or Ã = U+00C3) followed by a Latin-1
      //   continuation byte (U+0080–U+00BF, the second byte of any 2-byte
      //   UTF-8 sequence).  Reconstructs the original Unicode code point.
      //   Formula: ((lead & 0x1F) << 6) | (trail & 0x3F)
      //   Examples:  Ã© (0xC3 0xA9) → é U+00E9
      //              Ã\u00A0 (0xC3 0xA0) → à U+00E0  (NOT Ã+space!)
      //              Ã± (0xC3 0xB1) → ñ U+00F1
      .replace(/([\u00C2\u00C3])([\u0080-\u00BF])/g, (_m, lead: string, trail: string) => {
        const codePoint =
          ((lead.charCodeAt(0) & 0x1f) << 6) | (trail.charCodeAt(0) & 0x3f)
        return String.fromCodePoint(codePoint)
      })
      // Trim + collapse whitespace (no case change)
      .trim()
      .replace(/\s+/g, ' ')
  )
}

/**
 * Canonical key for bracket↔category lookup.
 * Applies repairMojibakeForDisplay then lowercase.
 *
 * Intentionally does NOT apply NFKD diacritic-folding (é→e, ñ→n, etc.).
 * Folding causes key collisions when a dataset has both a group named "n"
 * and a group named "ñ" — both would map to the same alias-map entry and
 * the second would silently overwrite the first, producing wrong brackets.
 *
 * The mojibake repair layer already handles encoding variants (Â°→°, Ã±→ñ),
 * so distinct labels remain distinct after canonicalization.
 *
 * Use on BOTH sides of any bracket group name comparison (alias map keys and
 * bracket group1/group2 lookup keys) — never on the canonical display value.
 */
export function canonicalizeBracketGroupKey(value: string): string {
  return repairMojibakeForDisplay(value).toLowerCase()
}
