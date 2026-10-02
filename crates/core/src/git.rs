use std::path::Path;
use std::process::Command;

use crate::{Error, Result};

/// Executa `git` com argumentos separados (nunca via shell) e retorna o stdout sem
/// a quebra de linha final.
pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    run_with_codes(cwd, args, &[0])
}

/// Como [`run`], mas aceita outros códigos de saída como sucesso
/// (ex.: `git diff --no-index` sai com 1 quando há diferenças).
pub fn run_with_codes(cwd: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.code().is_some_and(|c| ok_codes.contains(&c)) {
        return Err(Error::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_owned())
}
