import assert from 'node:assert/strict';
import test from 'node:test';
import { es } from '../src/es';
import { getLanguage, setLanguage, t } from '../src/i18n';

test('English shows as written; Spanish looks up whole lines, lines with values, and keeps surrounding spaces', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('Board'), 'Board');
  setLanguage('es');
  assert.equal(t('Board'), 'Tablero');
  assert.equal(t(' Add '), ' Agregar ', 'spaces around a word stay');
  assert.equal(t('3 of 5 left today'), 'Quedan 3 de 5 hoy', 'values fill the Spanish line in their places');
  assert.equal(t('GKR picks this far from the line have hit 67% (425 graded)'), 'Los picks de GKR a esta distancia de la línea han acertado 67% (425 calificados)');
  assert.equal(t('Tarik Skubal'), 'Tarik Skubal', 'names pass through');
  assert.equal(t('MORE'), 'MORE', 'the apps’ own words stay');
  setLanguage('en');
});

test('every Spanish line keeps the same values as its English line', () => {
  for (const [english, spanish] of Object.entries(es))
    assert.deepEqual((spanish.match(/\{\d+\}/g) ?? []).sort(), (english.match(/\{\d+\}/g) ?? []).sort(), english);
});

test('dismissing the first-run note is seen by listeners even though the language stays the same', async () => {
  const { dismissLanguagePrompt, languagePromptNeeded } = await import('../src/i18n');
  dismissLanguagePrompt();
  assert.equal(languagePromptNeeded(), false);
});

test('values that are phrases get translated inside a line, and dates come out in Spanish', () => {
  setLanguage('es');
  assert.equal(t('0 picks · Hand-picked'), '0 picks · Elegido a mano');
  assert.equal(t('Thu, Jan 15'), 'jue, 15 ene');
  assert.equal(t('Wed 3:00 AM'), 'mié 3:00 AM');
  assert.equal(t('Tomorrow'), 'Mañana');
  setLanguage('en');
});
