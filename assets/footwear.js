(function () {
  const footwear = /\b(?:scarp[ae]|calzature|sneakers?|shoes?|footwear|chaussures?|stivaletti?|stival[ei]|sandal[io]s?|sandals?|mocassin[io]|loafers?|boots?|booties|ciabatt[ae]|infradito|pantofole|slippers?|clogs?|sabot|espadrilles?|ballerin[ae]|anfib[io]+|decollete)\b/i;
  const other = /\b(?:giacch\w*|giacc[ae]|giubb\w*|jacket\w*|windbreakers?|cappott[io]|piumin[io]|parka|tut[ae]|tracksuits?|fuseaux|fuso|collants?|tights?|leggings?|magli[ae]|magliett[ae]|t shirts?|jerseys?|pantalon\w*|trousers?|shorts|felp[ae]|hoodies?|calzin\w*|calz[ae]|socks?|guant[io]|berrett[io]|cappell[io]|zain[io]|bors[ae]|portafogli|ombrell[io]|lacci|shoelaces?|solet\w*|insoles?|shoe cleaner|shoe care|lucido per scarpe|portascarpe|sacche? portascarpe)\b/i;
  function isFootwear(title, category = '') {
    const normalize = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const name = normalize(title);
    if (!name || other.test(name)) return false;
    const model = /\b(?:adidas (?:campus|samba|gazelle|handball spezial|superstar)|nike (?:air force 1|air max|p 6000|vomero|dunk)|new balance (?:327|530|550|574|9060)|asics (?:gel kayano|gel nimbus|gel cumulus|upcourt)|hoka (?:clifton|bondi|crescendo|speedgoat))\b/;
    const type = normalize(category);
    return footwear.test(name) || model.test(name) ||
      (!other.test(type) && (footwear.test(type) || type === '187'));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = isFootwear;
  else window.isCatalogFootwear = isFootwear;
})();
