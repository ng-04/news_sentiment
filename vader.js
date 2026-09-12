/*
 * Faithful JS port of NLTK's VADER sentiment algorithm (Hutto & Gilbert, 2014),
 * paired with a lexicon merged the same way the Python `finvader` package
 * does it: the base VADER lexicon with each SentiBignomics finance-lexicon
 * entry (Hosseini et al.) overriding the base word's valence, scaled by 0.1.
 * The merged lexicon itself lives in finvader-lexicon.json (built offline
 * from the same source data finvader uses) and is loaded once via fetch.
 *
 * Ported algorithm sections mirror nltk/sentiment/vader.py 1:1 (constants,
 * booster/negation word lists, ALLCAPS + punctuation emphasis, "but"
 * clause reweighting, idiom special-cases, compound-score normalization)
 * so headline scores match what `finvader(text, indicator="compound",
 * use_sentibignomics=True)` would return in Python.
 */

const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;
const N_SCALAR = -0.74;

const NEGATE = new Set([
  "aint", "arent", "cannot", "cant", "couldnt", "darent", "didnt", "doesnt",
  "ain't", "aren't", "can't", "couldn't", "daren't", "didn't", "doesn't",
  "dont", "hadnt", "hasnt", "havent", "isnt", "mightnt", "mustnt", "neither",
  "don't", "hadn't", "hasn't", "haven't", "isn't", "mightn't", "mustn't",
  "neednt", "needn't", "never", "none", "nope", "nor", "not", "nothing",
  "nowhere", "oughtnt", "shant", "shouldnt", "uhuh", "wasnt", "werent",
  "oughtn't", "shan't", "shouldn't", "uh-uh", "wasn't", "weren't", "without",
  "wont", "wouldnt", "won't", "wouldn't", "rarely", "seldom", "despite",
]);

const BOOSTER_DICT = {
  absolutely: B_INCR, amazingly: B_INCR, awfully: B_INCR, completely: B_INCR,
  considerably: B_INCR, decidedly: B_INCR, deeply: B_INCR, effing: B_INCR,
  enormously: B_INCR, entirely: B_INCR, especially: B_INCR, exceptionally: B_INCR,
  extremely: B_INCR, fabulously: B_INCR, flipping: B_INCR, flippin: B_INCR,
  fricking: B_INCR, frickin: B_INCR, frigging: B_INCR, friggin: B_INCR,
  fully: B_INCR, fucking: B_INCR, greatly: B_INCR, hella: B_INCR, highly: B_INCR,
  hugely: B_INCR, incredibly: B_INCR, intensely: B_INCR, majorly: B_INCR,
  more: B_INCR, most: B_INCR, particularly: B_INCR, purely: B_INCR, quite: B_INCR,
  really: B_INCR, remarkably: B_INCR, so: B_INCR, substantially: B_INCR,
  thoroughly: B_INCR, totally: B_INCR, tremendously: B_INCR, uber: B_INCR,
  unbelievably: B_INCR, unusually: B_INCR, utterly: B_INCR, very: B_INCR,
  almost: B_DECR, barely: B_DECR, hardly: B_DECR, "just enough": B_DECR,
  "kind of": B_DECR, kinda: B_DECR, kindof: B_DECR, "kind-of": B_DECR,
  less: B_DECR, little: B_DECR, marginally: B_DECR, occasionally: B_DECR,
  partly: B_DECR, scarcely: B_DECR, slightly: B_DECR, somewhat: B_DECR,
  "sort of": B_DECR, sorta: B_DECR, sortof: B_DECR, "sort-of": B_DECR,
};

const SPECIAL_CASE_IDIOMS = {
  "the shit": 3, "the bomb": 3, "bad ass": 1.5, "yeah right": -2,
  "cut the mustard": 2, "kiss of death": -1.5, "hand to mouth": -2,
};

const PUNCTUATION_CHARS = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const PUNC_LIST = [
  ".", "!", "?", ",", ";", ":", "-", "'", '"',
  "!!", "!!!", "??", "???", "?!?", "!?!", "?!?!", "!?!?",
];

function removePunctuation(text) {
  let out = "";
  for (const ch of text) {
    out += PUNCTUATION_CHARS.includes(ch) ? "" : ch;
  }
  return out;
}

function isUpper(word) {
  return word === word.toUpperCase() && word !== word.toLowerCase();
}

function negated(inputWords, includeNt = true) {
  if (inputWords.some((w) => NEGATE.has(w.toLowerCase()))) return true;
  if (includeNt && inputWords.some((w) => w.toLowerCase().includes("n't"))) return true;
  for (let i = 0; i < inputWords.length - 1; i++) {
    if (inputWords[i + 1].toLowerCase() === "least" && inputWords[i].toLowerCase() !== "at") {
      return true;
    }
  }
  return false;
}

function normalizeScore(score, alpha = 15) {
  return score / Math.sqrt(score * score + alpha);
}

function scalarIncDec(word, valence, isCapDiff) {
  let scalar = 0;
  const wordLower = word.toLowerCase();
  if (wordLower in BOOSTER_DICT) {
    scalar = BOOSTER_DICT[wordLower];
    if (valence < 0) scalar *= -1;
    if (isUpper(word) && isCapDiff) {
      scalar += valence > 0 ? C_INCR : -C_INCR;
    }
  }
  return scalar;
}

class SentiText {
  constructor(text) {
    this.text = text;
    this.wordsAndEmoticons = this._wordsAndEmoticons();
    this.isCapDiff = this._allcapDifferential(this.wordsAndEmoticons);
  }

  _wordsPlusPunc() {
    const noPuncText = removePunctuation(this.text);
    const wordsOnly = [...new Set(noPuncText.split(/\s+/).filter((w) => w.length > 1))];
    const dict = {};
    for (const p of PUNC_LIST) {
      for (const w of wordsOnly) {
        dict[p + w] = w;
        dict[w + p] = w;
      }
    }
    return dict;
  }

  _wordsAndEmoticons() {
    const wes = this.text.split(/\s+/).filter((w) => w.length > 1);
    const puncDict = this._wordsPlusPunc();
    return wes.map((we) => (we in puncDict ? puncDict[we] : we));
  }

  _allcapDifferential(words) {
    const allcapWords = words.filter((w) => isUpper(w)).length;
    const capDifferential = words.length - allcapWords;
    return capDifferential > 0 && capDifferential < words.length;
  }
}

export class VaderSentiment {
  constructor(lexicon) {
    this.lexicon = lexicon;
  }

  polarityScores(text) {
    const sentitext = new SentiText(text);
    const wae = sentitext.wordsAndEmoticons;

    const firstIndex = {};
    wae.forEach((token, idx) => {
      if (!(token in firstIndex)) firstIndex[token] = idx;
    });

    let sentiments = [];
    for (const item of wae) {
      const i = firstIndex[item];
      const itemLower = item.toLowerCase();
      if (
        (i < wae.length - 1 && itemLower === "kind" && wae[i + 1].toLowerCase() === "of") ||
        itemLower in BOOSTER_DICT
      ) {
        sentiments.push(0);
        continue;
      }
      sentiments = this._sentimentValence(sentitext, item, i, sentiments);
    }

    sentiments = this._butCheck(wae, sentiments);
    return this._scoreValence(sentiments, text);
  }

  _sentimentValence(sentitext, item, i, sentiments) {
    const isCapDiff = sentitext.isCapDiff;
    const wae = sentitext.wordsAndEmoticons;
    const itemLower = item.toLowerCase();
    let valence = 0;

    if (itemLower in this.lexicon) {
      valence = this.lexicon[itemLower];

      if (isUpper(item) && isCapDiff) {
        valence += valence > 0 ? C_INCR : -C_INCR;
      }

      for (let startI = 0; startI < 3; startI++) {
        if (i > startI && !(wae[i - (startI + 1)].toLowerCase() in this.lexicon)) {
          let s = scalarIncDec(wae[i - (startI + 1)], valence, isCapDiff);
          if (startI === 1 && s !== 0) s *= 0.95;
          if (startI === 2 && s !== 0) s *= 0.9;
          valence += s;
          valence = this._neverCheck(valence, wae, startI, i);
          if (startI === 2) {
            valence = this._idiomsCheck(valence, wae, i);
          }
        }
      }
      valence = this._leastCheck(valence, wae, i);
    }

    sentiments.push(valence);
    return sentiments;
  }

  _leastCheck(valence, wae, i) {
    if (i > 1 && !(wae[i - 1].toLowerCase() in this.lexicon) && wae[i - 1].toLowerCase() === "least") {
      if (wae[i - 2].toLowerCase() !== "at" && wae[i - 2].toLowerCase() !== "very") {
        valence *= N_SCALAR;
      }
    } else if (i > 0 && !(wae[i - 1].toLowerCase() in this.lexicon) && wae[i - 1].toLowerCase() === "least") {
      valence *= N_SCALAR;
    }
    return valence;
  }

  _butCheck(wae, sentiments) {
    const lower = wae.map((w) => w.toLowerCase());
    const bi = lower.indexOf("but");
    if (bi !== -1) {
      return sentiments.map((s, idx) => {
        if (idx < bi) return s * 0.5;
        if (idx > bi) return s * 1.5;
        return s;
      });
    }
    return sentiments;
  }

  _idiomsCheck(valence, wae, i) {
    const onezero = `${wae[i - 1]} ${wae[i]}`;
    const twoonezero = `${wae[i - 2]} ${wae[i - 1]} ${wae[i]}`;
    const twoone = `${wae[i - 2]} ${wae[i - 1]}`;
    const threetwoone = i >= 3 ? `${wae[i - 3]} ${wae[i - 2]} ${wae[i - 1]}` : "";
    const threetwo = i >= 3 ? `${wae[i - 3]} ${wae[i - 2]}` : "";

    for (const seq of [onezero, twoonezero, twoone, threetwoone, threetwo]) {
      if (seq in SPECIAL_CASE_IDIOMS) {
        valence = SPECIAL_CASE_IDIOMS[seq];
        break;
      }
    }

    if (wae.length - 1 > i) {
      const zeroone = `${wae[i]} ${wae[i + 1]}`;
      if (zeroone in SPECIAL_CASE_IDIOMS) valence = SPECIAL_CASE_IDIOMS[zeroone];
    }
    if (wae.length - 1 > i + 1) {
      const zeroonetwo = `${wae[i]} ${wae[i + 1]} ${wae[i + 2]}`;
      if (zeroonetwo in SPECIAL_CASE_IDIOMS) valence = SPECIAL_CASE_IDIOMS[zeroonetwo];
    }

    if (threetwo in BOOSTER_DICT || twoone in BOOSTER_DICT) {
      valence += B_DECR;
    }
    return valence;
  }

  _neverCheck(valence, wae, startI, i) {
    if (startI === 0) {
      if (negated([wae[i - 1]])) valence *= N_SCALAR;
    }
    if (startI === 1) {
      if (wae[i - 2] === "never" && (wae[i - 1] === "so" || wae[i - 1] === "this")) {
        valence *= 1.5;
      } else if (negated([wae[i - (startI + 1)]])) {
        valence *= N_SCALAR;
      }
    }
    if (startI === 2) {
      if (
        (wae[i - 3] === "never" && (wae[i - 2] === "so" || wae[i - 2] === "this")) ||
        wae[i - 1] === "so" ||
        wae[i - 1] === "this"
      ) {
        valence *= 1.25;
      } else if (negated([wae[i - (startI + 1)]])) {
        valence *= N_SCALAR;
      }
    }
    return valence;
  }

  _amplifyEp(text) {
    let epCount = (text.match(/!/g) || []).length;
    if (epCount > 4) epCount = 4;
    return epCount * 0.292;
  }

  _amplifyQm(text) {
    const qmCount = (text.match(/\?/g) || []).length;
    if (qmCount > 1) {
      return qmCount <= 3 ? qmCount * 0.18 : 0.96;
    }
    return 0;
  }

  _siftSentimentScores(sentiments) {
    let posSum = 0;
    let negSum = 0;
    let neuCount = 0;
    for (const s of sentiments) {
      if (s > 0) posSum += s + 1;
      if (s < 0) negSum += s - 1;
      if (s === 0) neuCount += 1;
    }
    return { posSum, negSum, neuCount };
  }

  _scoreValence(sentiments, text) {
    if (sentiments.length === 0) {
      return { neg: 0, neu: 0, pos: 0, compound: 0 };
    }

    let sumS = sentiments.reduce((a, b) => a + b, 0);
    const punctEmphAmplifier = this._amplifyEp(text) + this._amplifyQm(text);
    if (sumS > 0) sumS += punctEmphAmplifier;
    else if (sumS < 0) sumS -= punctEmphAmplifier;

    const compound = normalizeScore(sumS);
    let { posSum, negSum, neuCount } = this._siftSentimentScores(sentiments);

    if (posSum > Math.abs(negSum)) posSum += punctEmphAmplifier;
    else if (posSum < Math.abs(negSum)) negSum -= punctEmphAmplifier;

    const total = posSum + Math.abs(negSum) + neuCount;
    const pos = Math.abs(posSum / total);
    const neg = Math.abs(negSum / total);
    const neu = Math.abs(neuCount / total);

    return {
      neg: round3(neg),
      neu: round3(neu),
      pos: round3(pos),
      compound: round4(compound),
    };
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

let lexiconPromise = null;

export function loadFinvaderLexicon() {
  if (!lexiconPromise) {
    lexiconPromise = fetch("finvader-lexicon.json").then((res) => {
      if (!res.ok) throw new Error(`Failed to load sentiment lexicon (${res.status})`);
      return res.json();
    });
  }
  return lexiconPromise;
}
