import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders what an agent writes back.
 *
 * Agent output is markdown: short reports, bullet lists and — very often — GFM
 * pipe tables. react-markdown builds React elements rather than HTML, so there
 * is no injection path, and unknown HTML in the model's reply is ignored rather
 * than rendered.
 *
 * Links are forced to a new tab: an agent citing a source should never navigate
 * the console away from a running task.
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  // Wide tables scroll inside their own box instead of stretching the panel.
  table: ({ children }) => (
    <div className="md-table"><table>{children}</table></div>
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
