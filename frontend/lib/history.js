/** DuckDuckGo occasionally returns something URL() will not parse. */
export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * Every page a search returned this session, most recently seen first.
 *
 * The backend only deduplicates within one question, so a URL a second question turns up
 * again arrives twice. Keeping the later sighting rather than the first is what makes the
 * list read as a log: the pages in play right now sit at the top.
 */
export const historyOf = (turns) => {
  const byUrl = new Map();

  for (const turn of turns)
    for (const search of turn.searches ?? [])
      for (const result of search.results ?? []) {
        if (!result.url) continue;
        // A Map keeps a key at its original position on re-set, so the delete is what
        // actually moves a repeated URL to the end.
        byUrl.delete(result.url);
        byUrl.set(result.url, result);
      }

  return [...byUrl.values()].reverse();
};
