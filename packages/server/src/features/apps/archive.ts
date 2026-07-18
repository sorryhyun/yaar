/**
 * Build the tar invocation used by marketplace installs.
 *
 * Keep the archive and destination paths relative to cwd. GNU tar interprets a
 * colon in an archive name as remote `host:path` syntax, so passing an absolute
 * Windows path such as `C:\\...\\app.tar.gz` makes it try to connect to host C.
 */
export function buildTarExtractInvocation(
  tmpDir: string,
  archiveName: string,
  stagingDirName: string,
): { argv: string[]; cwd: string } {
  return {
    argv: ['tar', 'xzf', archiveName, '--strip-components=1', '-C', stagingDirName],
    cwd: tmpDir,
  };
}
