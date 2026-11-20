import type { ReactNode } from 'react';

/**
 * The three text styles of a settings page (remake #307, mockup #299), so they never look alike:
 * a section title (16/670 with a rule above), a field label (14/530 with a 13 px help line, its control on the right)
 * and the navigation item (SettingsView). The header names the page: a page never repeats its title.
 */
export function SetSec(props: { title?: ReactNode; help?: ReactNode; first?: boolean; className?: string; label?: string; children?: ReactNode }) {
  return (
    <section className={'set-sec' + (props.first ? ' first' : '') + (props.className ? ' ' + props.className : '')} aria-label={props.label}>
      {props.title && <h2 className="set-sec-title">{props.title}</h2>}
      {props.help && <p className="set-sec-help">{props.help}</p>}
      {props.children}
    </section>
  );
}

/**
 * One setting: label and help line on the left, the control on the right (below it with `stack`, for wide controls).
 * `auto`: the control keeps its own width (a switch, a button, a segmented control). No hover: it is not a link.
 */
export function SetRow(props: { label: ReactNode; help?: ReactNode; stack?: boolean; auto?: boolean; danger?: boolean; htmlFor?: string; children?: ReactNode }) {
  const Label = props.htmlFor ? 'label' : 'span';
  return (
    <div className={'set-row' + (props.stack ? ' stack' : '') + (props.danger ? ' danger' : '')}>
      <div className="set-row-text">
        <Label className="set-label" htmlFor={props.htmlFor}>
          {props.label}
        </Label>
        {props.help && <span className="set-help">{props.help}</span>}
      </div>
      {props.children !== undefined && <div className={'set-ctl' + (props.auto ? ' auto' : '')}>{props.children}</div>}
    </div>
  );
}

/** A bordered group of SetRows. */
export function SetRows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="set-rows" role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  );
}
