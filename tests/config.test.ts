import { config } from '../src/config';
import { PERSONA } from '../src/persona';

test('PERSONA mentions English, Danish and Solrød', () => {
  expect(PERSONA).toContain('English');
  expect(PERSONA).toContain('Danish');
  expect(PERSONA).toContain('Solrød');
});

test('PERSONA tells the assistant to answer briefly and to say plainly it cannot access calendar, weather or the web yet', () => {
  expect(PERSONA.toLowerCase()).toContain('brief');
  expect(PERSONA.toLowerCase()).toContain('calendar');
  expect(PERSONA.toLowerCase()).toContain('weather');
  expect(PERSONA.toLowerCase()).toMatch(/web|internet/);
  expect(PERSONA.toLowerCase()).toContain('cannot');
});

test('config.provider defaults to gemini', () => {
  expect(config.provider).toBe('gemini');
  expect(config.model.length).toBeGreaterThan(0);
  expect(config.tokenUrl.length).toBeGreaterThan(0);
});

test('PERSONA defaults to English, allows Danish only when the person speaks or asks for it, and forbids other languages', () => {
  const t = PERSONA.toLowerCase();
  expect(t).toMatch(/default.*english|english by default|reply in english/);
  expect(t).toContain('danish');
  expect(t).toMatch(/never.*(german|swedish|norwegian)|only english and danish/);
  expect(t).toMatch(/accent|unclear|sounds like another language/);
});

import { personaFor, speechLanguageCodes } from '../src/persona';

test('PERSONA tells the assistant to stay quiet on "mhm"/"okay" and never to ask "anything else?"', () => {
  const t = PERSONA.toLowerCase();
  expect(t).toContain('mhm');
  expect(t).toMatch(/anything else/);
  expect(t).toMatch(/silent|stay quiet|say nothing/);
});

test('personaFor locks the reply language for English and Danish and equals PERSONA for auto', () => {
  expect(personaFor('auto')).toBe(PERSONA);
  expect(personaFor('en').toLowerCase()).toMatch(/only in english/);
  expect(personaFor('da').toLowerCase()).toMatch(/only in danish/);
});

test('speechLanguageCodes limits what the microphone transcription may guess', () => {
  expect(speechLanguageCodes('auto')).toEqual(['en-US', 'da-DK']);
  expect(speechLanguageCodes('en')).toEqual(['en-US']);
  expect(speechLanguageCodes('da')).toEqual(['da-DK']);
});

import { VOICES } from '../src/persona';

test('PERSONA describes a warm, relaxed, human way of talking', () => {
  const t = PERSONA.toLowerCase();
  expect(t).toMatch(/warm/);
  expect(t).toMatch(/relaxed|calm/);
  expect(t).toMatch(/contraction|natural/);
});

test('VOICES offers four female and four male Gemini voices', () => {
  expect(VOICES.filter((v) => v.gender === 'female')).toHaveLength(4);
  expect(VOICES.filter((v) => v.gender === 'male')).toHaveLength(4);
  expect(VOICES.map((v) => v.name)).toContain('Kore');
});
