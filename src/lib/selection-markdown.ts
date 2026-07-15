import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let service: TurndownService | null = null;

const getService = (): TurndownService => {
  if (service) return service;
  const s = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    hr: '---',
  });
  s.use(gfm);
  // turndown은 "숫자. " 를 순서 리스트 마커로 오인해 헤딩·본문 텍스트에서도 이스케이프한다(1\.).
  // 실제 순서 리스트는 별도 규칙이 번호를 붙이므로, 텍스트에 잘못 붙은 이스케이프만 되돌린다.
  const defaultEscape = s.escape.bind(s);
  s.escape = (str: string) => defaultEscape(str).replace(/^(\d+)\\\. /, '$1. ');
  service = s;
  return s;
};

/** 렌더된 HTML을 마크다운으로 변환한다(헤더·목록·코드블록·표 형식 유지). */
export const htmlToMarkdown = (html: string): string => {
  if (!html.trim()) return '';
  return getService().turndown(html).trim();
};

/**
 * 현재 텍스트 선택 영역을 마크다운으로 변환한다.
 * 선택이 없거나 container 밖이면 null.
 */
export const selectionToMarkdown = (container: HTMLElement): string | null => {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (!selection.anchorNode || !container.contains(selection.anchorNode)) return null;

  const wrapper = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i += 1) {
    wrapper.appendChild(selection.getRangeAt(i).cloneContents());
  }
  const markdown = htmlToMarkdown(wrapper.innerHTML);
  return markdown || null;
};
