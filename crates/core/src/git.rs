use std::path::Path;
use std::process::Command;

use crate::{Error, Result};

/// Executa `git` com argumentos separados (nunca via shell) e retorna o stdout sem
/// a quebra de linha final.
pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git").args(args).current_dir(cwd).output()?;
    if !output.status.success() {
        return Err(Error::Git {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_owned())
}
