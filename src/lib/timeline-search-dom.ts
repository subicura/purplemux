/** container 내부 텍스트에서 needle(소문자)과 일치하는 모든 Range를 수집한다. */
export const collectMatchRanges = (container: Node, needle: string): Range[] => {
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;
    const hay = text.toLowerCase();
    let from = hay.indexOf(needle);
    while (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = hay.indexOf(needle, from + needle.length);
    }
  }
  return ranges;
};

/** container 내부 첫 일치 Range를 반환한다. 없으면 null. */
export const firstMatchRange = (container: Node, needle: string): Range | null => {
  if (!needle) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue;
    if (!text) continue;
    const from = text.toLowerCase().indexOf(needle);
    if (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      return range;
    }
  }
  return null;
};
