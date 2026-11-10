// GFM's bare-URL autolinks run on to the next space, so emphasis written right around a URL (**https://…**, common in
// model replies, often followed by CJK punctuation) becomes part of the link and the emphasis is left unmatched. An
// angle-bracket autolink ends where its bracket does, so wrapping such a URL in <…> keeps the emphasis intact.
// Fenced and inline code are left as written.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const EMPHASIZED_URL = /(\*\*|__|\*|_)(https?:\/\/[^\s<>*_`]+?)\1/g;

function wrapLine(line: string): string {
  // Odd-numbered pieces are inside inline code spans.
  return line.split(/(`+[^`]*`+)/).map((piece, index) => index % 2 ? piece : piece.replace(EMPHASIZED_URL, '$1<$2>$1')).join('');
}

export function wrapEmphasizedUrls(markdown: string): string {
  if (!markdown.includes('://')) return markdown;
  let fence = '';
  return markdown.split('\n').map(line => {
    const open = FENCE.exec(line)?.[1];
    if (fence) { if (open && open[0] === fence[0] && open.length >= fence.length) fence = ''; return line; }
    if (open) { fence = open; return line; }
    return wrapLine(line);
  }).join('\n');
}

// Bare URLs that GFM leaves as text (an IP:port next to CJK punctuation, a URL
// inside a list item, …) never become anchors — the model writes them as plain
// text and remark stops its autolink at characters it reads as punctuation.
// Angle brackets are unambiguous autolink syntax, so wrap the bare ones and
// hand the trailing punctuation (CJK comma, full stop, closing bracket) back
// to the sentence.
const BARE_URL = /https?:\/\/[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>，。；：！？、）】」》"'…]+$/;

export function linkifyBareUrls(markdown: string): string {
  if (!markdown.includes('://')) return markdown;
  let fence = '';
  return markdown.split('\n').map(line => {
    const open = FENCE.exec(line)?.[1];
    if (fence) { if (open && open[0] === fence[0] && open.length >= fence.length) fence = ''; return line; }
    if (open) { fence = open; return line; }
    return line.split(/(`+[^`]*`+)/).map((piece, index) => {
      if (index % 2) return piece;
      return piece.replace(BARE_URL, (match: string, offset: number) => {
        const before = piece[offset - 1] ?? '';
        // Already an autolink / markdown link target — leave it alone.
        if (before === '<' || before === '(') return match;
        const url = match.replace(TRAILING_PUNCTUATION, '');
        return '<' + url + '>' + match.slice(url.length);
      });
    }).join('');
  }).join('\n');
}
