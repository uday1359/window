/** Cited research results (FR-18). Every value here comes from untrusted web pages. */
interface Source {
  id: string;
  url: string;
  title?: string;
  domain: string;
  trust: 'official' | 'reference' | 'general';
}

interface Findings {
  claims: Array<{ text: string; sources: string[]; status: 'verified' | 'single-source' }>;
  model: string | null;
  note: string;
}

const TRUST_LABEL: Record<Source['trust'], string> = { official: 'Official', reference: 'Reference', general: 'General' };

// Only plain web links are clickable; anything else (javascript:, file:) is shown as text.
const safeHref = (url: string): string | undefined => (/^https?:\/\//i.test(url) ? url : undefined);

export function ResearchFindings({ output }: { output: Record<string, unknown> }) {
  const sources = Array.isArray(output.sources) ? (output.sources as Source[]) : [];
  const findings = output.findings as Findings | undefined;
  if (!sources.length && !findings) return null;
  const byId = new Map(sources.map((s) => [s.id, s]));
  return (
    <section className="research" aria-label="Research findings">
      {findings && (
        <>
          <p className="muted small">{findings.note}</p>
          {findings.claims.length > 0 && (
            <ul className="claims">
              {findings.claims.map((c, i) => (
                <li key={i}>
                  <span className={`badge ${c.status === 'verified' ? 'badge-ok' : 'badge-warn'}`}>{c.status === 'verified' ? 'Verified' : 'Single source – uncertain'}</span> {c.text}{' '}
                  {c.sources.map((id) => {
                    const s = byId.get(id);
                    const href = s ? safeHref(s.url) : undefined;
                    return href ? (
                      <a key={id} href={href} target="_blank" rel="noopener noreferrer" title={s!.domain}>
                        [{id}]
                      </a>
                    ) : (
                      <span key={id}>[{id}]</span>
                    );
                  })}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {sources.length > 0 && (
        <ol className="sources small">
          {sources.map((s) => {
            const href = safeHref(s.url);
            return (
              <li key={s.id}>
                <strong>{s.id}</strong> <span className="badge badge-neutral">{TRUST_LABEL[s.trust] ?? s.trust}</span>{' '}
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {s.title || s.domain}
                  </a>
                ) : (
                  s.title || s.domain
                )}{' '}
                <span className="muted">({s.domain})</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
