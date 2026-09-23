/** Lightweight script/stop-word language detection → ISO 639-1, or "und". */
const STOP: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "shall", "in", "for", "with", "this", "is"],
  fr: ["le", "la", "les", "et", "des", "du", "pour", "est", "une", "dans"],
  es: ["el", "la", "los", "las", "y", "del", "para", "que", "una", "con"],
  de: ["der", "die", "das", "und", "des", "für", "mit", "ist", "eine", "nicht"],
  pt: ["o", "os", "as", "e", "do", "da", "para", "que", "uma", "com"],
  it: ["il", "lo", "gli", "e", "del", "della", "per", "che", "una", "con"],
  nl: ["de", "het", "een", "en", "van", "voor", "met", "is", "niet", "op"]
};

export function detectLanguage(text: string): { language: string; confidence: number } {
  const sample = text.slice(0, 20_000);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 20) return { language: "und", confidence: 0 };
  const count = (re: RegExp) => sample.match(re)?.length ?? 0;
  const scripts: [string, number][] = [
    ["ar", count(/[؀-ۿ]/g)], ["zh", count(/[一-鿿]/g)], ["ja", count(/[぀-ヿ]/g)], ["ko", count(/[가-힯]/g)],
    ["ru", count(/[Ѐ-ӿ]/g)], ["el", count(/[Ͱ-Ͽ]/g)], ["he", count(/[֐-׿]/g)], ["hi", count(/[ऀ-ॿ]/g)], ["th", count(/[฀-๿]/g)]
  ];
  const [topScript, topCount] = scripts.sort((a, b) => b[1] - a[1])[0]!;
  if (topCount / letters > 0.3) {
    if (topScript === "zh" && count(/[぀-ヿ]/g) > 0) return { language: "ja", confidence: 0.8 };
    return { language: topScript, confidence: Math.min(0.95, 0.5 + topCount / letters / 2) };
  }
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = Object.entries(STOP).map(([lang, list]) => [lang, list.reduce((s, w) => s + (freq.get(w) ?? 0), 0)] as const).sort((a, b) => b[1] - a[1]);
  const [lang, hits] = scored[0]!;
  const runner = scored[1]![1];
  if (hits < 3 && hits >= 1 && runner === 0 && lang === "en") return { language: "en", confidence: 0.55 };
  if (hits < 3 && !(hits >= 1 && runner === 0 && lang === "en")) return { language: "und", confidence: 0 };
  return { language: lang, confidence: Math.min(0.95, 0.5 + (hits - runner) / Math.max(hits, 1) * 0.45) };
}
