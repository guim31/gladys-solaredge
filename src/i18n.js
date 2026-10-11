// -----------------------------------------------------------------------------
// Languages of the texts sent to Gladys.
//
// Gladys shows the user's language when a text has it, English otherwise
// (`getLocalizedText` of the front). Its interface exists in these four
// languages: every multi-language object of this integration carries exactly
// them, in the manifest as in the code (test/i18n.test.js enforces it).
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Build a multi-language object from one function per language.
 * @param {(language: string) => string} text
 * @returns {Record<string, string>}
 */
export function localize(text) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, text(language)]));
}
