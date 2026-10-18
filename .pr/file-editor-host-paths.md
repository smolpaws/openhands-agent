# File editor host paths

Remove the TypeScript-only workspace-prefix rejection. The configured workspace is context, not an editor sandbox; the host process's filesystem permissions remain authoritative. Public constructor options, schemas, operation semantics, existing-file protection, and relative-path resolution stay unchanged. No REST upload/download policy changes.

At the unchanged upstream pin in `transpile/upstream.json`, Python `FileEditor.__init__` describes workspace_root as cwd for path suggestions. `validate_path` accepts absolute paths on the host without requiring a workspace prefix. Removing our prefix guard narrows a divergence; it does not create a new DEV/EXC policy or advance the upstream pin. This change does not claim full editor parity: Python's absolute-path requirement and TypeScript's existing relative-path handling remain separate behavior.

Regression runs the actual FileEditorTool factory with a workspace and an absolute sibling private directory, exercising create, view, replace, insert, undo, and existing-file rejection. Before the fix, the first create rejects with `Path escapes workspace`; after the fix the lifecycle succeeds. All files live under a disposable temporary directory.

This tool was never a process sandbox: the terminal already has host access, and a lexical prefix check did not enforce symlink confinement. Hosts requiring isolation must provide an OS/container boundary. No server restart is part of this patch.
