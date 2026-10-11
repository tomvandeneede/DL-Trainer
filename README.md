# Duolingo Russian Word List – Chrome extension

Reads the words page of your **Russian** Duolingo course (`duolingo.com/practice-hub/words`) and saves every word to a JSON file:

- **Nouns** → nominative singular (`соседи` → `сосед`, `имени` → `имя`, `сыновья` → `сын`)
- **Adjectives, pronouns** → masculine nominative singular (`твоей` → `твой`, `хорошая` → `хороший`)
- **Feminine nouns for people** → masculine singular (`студентка` → `студент`, `ученица` → `ученик`)
- **Verbs** → infinitive (`учусь` → `учиться`, `будут` → `быть`, `готовила` → `готовить`)
- **Duplicates** are merged; the forms you saw on Duolingo are kept in `forms`.

Base forms are looked up on Wiktionary. When a word is both a word of its own and an inflected form (`дорогой` = "dear" or a form of `дорога`), the extension picks the meaning that best matches Duolingo's translation.

The extension also saves the **guidebook sentences** of every unit to a separate JSON file, and has **flashcards** for both words and sentences.

## Installing / updating

1. Go to `chrome://extensions` in Chrome and turn on **Developer mode**.
2. First time: **Load unpacked** → choose this folder.
   Updating: click the ↻ icon on the extension.
3. Then reload your Duolingo tab.

## Word list

1. Log in to Duolingo with your Russian course active.
2. Click the extension icon → **Fetch all from Duolingo**. The words page opens and every page of your word list is fetched (the counter runs up to the total, e.g. 754).
3. The base forms are then looked up: about 4 words per second, so a few minutes for a few hundred words. The popup shows "X words still to look up".
4. Click **Save JSON** → `Downloads/duolingo-wordlist/russian-words.json` (overwritten each time). **Save as…** lets you choose the location yourself.

**View & edit list** lets you search the list and correct a base form by hand.

## Guidebook sentences

In the popup, under **Guidebook sentences**, click **Fetch all units** (a Duolingo tab must be open, or one will be opened). The extension fetches the guidebook of every unit in the course, including locked units, and saves all sentences to a separate file: `Downloads/duolingo-wordlist/russian-guidebook-sentences.json`.

```json
{
  "source": "Duolingo guidebooks",
  "learningLanguage": "ru",
  "fromLanguage": "en",
  "exportedAt": "2026-10-10T13:00:00.000Z",
  "units": 95,
  "count": 545,
  "sentences": [
    { "russian": "Я Мария.", "english": "I am Maria.", "section": 1, "unit": 1, "courseUnit": 1, "unitTitle": "Make introductions", "topic": "Make introductions" }
  ]
}
```

- `section` = section number, `unit` = unit number within that section (as Duolingo shows them)
- `courseUnit` = running unit number across the whole course
- `unitTitle` = title of the unit, `topic` = heading in the guidebook the sentence appears under

## Flashcards

In the popup, click **Practise with flashcards**.

- Choose **Words** or **Guidebook sentences** at the top.
- **Direction**: English → Russian, Russian → English, or random (per card).
- For guidebook sentences, choose **Up to section** and **Up to unit**: you get all sentences from the earlier sections plus units 1 up to the chosen unit of that section. Tick **This unit only** to practise just that one unit.
- Click the card (or press space) to flip it; **Next** (or →) goes to the next card. Cards are shuffled; after the last card a new shuffled round starts.

## Word list JSON format

```json
{
  "source": "Duolingo",
  "learningLanguage": "ru",
  "fromLanguage": "en",
  "exportedAt": "2026-10-10T13:00:00.000Z",
  "totalSeen": 754,
  "count": 490,
  "words": [
    { "word": "сосед", "partOfSpeech": "noun", "translations": ["neighbour", "a neighbor", "neighbors"], "forms": ["соседи", "сосед"], "status": "lemma" }
  ]
}
```

`status`: `lemma` (already in base form), `inflected` (converted), `manual` (edited by hand), `unknown` (not found on Wiktionary, left unchanged).
