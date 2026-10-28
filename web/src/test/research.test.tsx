import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResearchFindings } from '../components/ResearchFindings';

const output = {
  sources: [
    { id: 'S1', url: 'https://docs.python.org/3/', title: 'Python docs', domain: 'docs.python.org', trust: 'official' },
    { id: 'S2', url: 'javascript:alert(1)', title: 'Evil page', domain: 'evil.example', trust: 'general' },
  ],
  findings: {
    claims: [
      { text: 'Python 3.13 was released in 2024', sources: ['S1'], status: 'verified' },
      { text: 'It is twice as fast', sources: ['S2'], status: 'single-source' },
    ],
    model: 'local',
    note: '2 claim(s) from 2 source(s); 1 verified, 1 single-source (treat as uncertain).',
  },
};

describe('ResearchFindings', () => {
  it('labels claims in text, not only colour, and links citations', () => {
    render(<ResearchFindings output={output} />);
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Single source – uncertain')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Python docs' })).toHaveAttribute('href', 'https://docs.python.org/3/');
    expect(screen.getByRole('link', { name: '[S1]' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never turns a non-http source URL into a link', () => {
    render(<ResearchFindings output={output} />);
    expect(screen.queryByRole('link', { name: 'Evil page' })).toBeNull();
    expect(screen.queryByRole('link', { name: '[S2]' })).toBeNull();
    expect(screen.getByText('Evil page')).toBeInTheDocument();
  });
});
