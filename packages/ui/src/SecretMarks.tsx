import { Fragment } from 'react';
import { hiddenPill, splitSecretMarks } from './secretsView.ts';

export { hiddenPill };

/** A text with each `[secret NAME]` the engine put in place of a value highlighted (#209, mockup #205). */
export function SecretText({ text }: { text: string }) {
  const parts = splitSecretMarks(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <Fragment key={i}>{p}</Fragment>
        ) : (
          <span key={i} className="sec-redacted" title={`The value of ${p.secret} is hidden`}>
            [secret {p.secret}]
          </span>
        ),
      )}
    </>
  );
}

/** Under a command's output: which values were hidden, and from whom. */
export function HiddenNote({ names }: { names: string[] }) {
  return (
    <>
      The {names.length === 1 ? 'value' : 'values'} of{' '}
      {names.map((n, i) => (
        <Fragment key={n}>
          {i > 0 && (i === names.length - 1 ? ' and ' : ', ')}
          <span className="sec-redacted">{n}</span>
        </Fragment>
      ))}{' '}
      {names.length === 1 ? 'was' : 'were'} in this output: Atlas replaced {names.length === 1 ? 'it' : 'them'} before the model, the chat and the logs saw{' '}
      {names.length === 1 ? 'it' : 'them'}.
    </>
  );
}
