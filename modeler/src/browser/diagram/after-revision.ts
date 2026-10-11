// The wait of a reveal for the update of a show (ui-manifest §3.2 law_revealAfterShowUpdate), without GLSP types: unit-testable.

/**
 * Resolves when `current()` reaches the revision that `target` gives, checked at each `onChange`; at most after `timeout` ms. A target
 * that fails (a closed session) resolves at once.
 */
export function afterRevision(target: Promise<number>, current: () => number, onChange: (l: () => void) => { dispose(): void }, timeout = 2000): Promise<void> {
    return new Promise(resolve => {
        let listener: { dispose(): void } | undefined, finished = false;
        const done = () => { finished = true; clearTimeout(timer); listener?.dispose(); resolve(); };
        const timer = setTimeout(done, timeout);
        target.then(revision => {
            // An answer after the timeout installs no listener: the timeout bounds the wait and the listener alike.
            if (finished) return;
            if (current() >= revision) return done();
            listener = onChange(() => { if (current() >= revision) done(); });
        }, () => { if (!finished) done(); });
    });
}
