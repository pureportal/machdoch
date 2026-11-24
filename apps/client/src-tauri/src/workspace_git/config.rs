use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use super::{git_directories, WorkspaceGitRemote};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigEntry {
    section: String,
    subsection: Option<String>,
    key: String,
    value: String,
}

fn unquote(raw: &str) -> String {
    let mut value = String::new();
    let mut quoted = false;
    let mut pending_space = String::new();
    let mut characters = raw.chars();
    while let Some(character) = characters.next() {
        match character {
            '"' => quoted = !quoted,
            '\\' => {
                value.push_str(&pending_space);
                pending_space.clear();
                match characters.next() {
                    Some('n') => value.push('\n'),
                    Some('t') => value.push('\t'),
                    Some('b') => {
                        value.pop();
                    }
                    Some(other) => value.push(other),
                    None => {}
                }
            }
            '#' | ';' if !quoted => break,
            ' ' | '\t' if !quoted => {
                if !value.is_empty() {
                    pending_space.push(character);
                }
            }
            other => {
                value.push_str(&pending_space);
                pending_space.clear();
                value.push(other);
            }
        }
    }
    value
}

fn parse_section_header(line: &str) -> Option<(String, Option<String>)> {
    let inner = line.strip_prefix('[')?;
    let end = inner.rfind(']')?;
    let inner = &inner[..end];
    if let Some((section, rest)) = inner.split_once('"') {
        let subsection = rest.strip_suffix('"').unwrap_or(rest);
        let subsection = subsection.replace("\\\"", "\"").replace("\\\\", "\\");
        return Some((section.trim().to_ascii_lowercase(), Some(subsection)));
    }
    match inner.split_once('.') {
        Some((section, subsection)) => Some((
            section.trim().to_ascii_lowercase(),
            Some(subsection.trim().to_ascii_lowercase()),
        )),
        None => Some((inner.trim().to_ascii_lowercase(), None)),
    }
}

fn parse_config(text: &str) -> Vec<ConfigEntry> {
    let mut entries = Vec::new();
    let mut section = None::<(String, Option<String>)>;
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let mut line = line.trim_start().to_string();
        while line.ends_with('\\') && !line.ends_with("\\\\") {
            line.pop();
            match lines.next() {
                Some(next) => line.push_str(next),
                None => break,
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let mut remainder = trimmed;
        if trimmed.starts_with('[') {
            let Some(close) = trimmed.find(']') else {
                continue;
            };
            section = parse_section_header(&trimmed[..=close]);
            remainder = trimmed[close + 1..].trim();
            if remainder.is_empty() || remainder.starts_with('#') || remainder.starts_with(';') {
                continue;
            }
        }
        let Some((name, subsection)) = section.clone() else {
            continue;
        };
        let (key, value) = match remainder.split_once('=') {
            Some((key, value)) => (key.trim(), unquote(value)),
            None => (remainder, "true".to_string()),
        };
        entries.push(ConfigEntry {
            section: name,
            subsection,
            key: key.to_ascii_lowercase(),
            value,
        });
    }
    entries
}

fn global_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(xdg) = env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(xdg).join("git").join("config"));
    }
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE"));
    if let Some(home) = home {
        let home = PathBuf::from(home);
        paths.push(home.join(".config").join("git").join("config"));
        paths.push(home.join(".gitconfig"));
    }
    paths
}

fn read_entries(path: &Path) -> Vec<ConfigEntry> {
    fs::read_to_string(path)
        .map(|text| parse_config(&text))
        .unwrap_or_default()
}

fn rewrite(url: &str, rules: &[(String, String)]) -> String {
    rules
        .iter()
        .filter(|(prefix, _)| url.starts_with(prefix.as_str()))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(prefix, base)| format!("{base}{}", &url[prefix.len()..]))
        .unwrap_or_else(|| url.to_string())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RepositoryConfig {
    pub(super) remotes: Vec<WorkspaceGitRemote>,
    pub(super) parents: BTreeMap<String, String>,
}

fn repository_config(local: Vec<ConfigEntry>, global: Vec<ConfigEntry>) -> RepositoryConfig {
    let mut instead_of = Vec::new();
    let mut push_instead_of = Vec::new();
    for entry in global.iter().chain(&local) {
        if entry.section != "url" {
            continue;
        }
        let Some(base) = entry.subsection.clone() else {
            continue;
        };
        match entry.key.as_str() {
            "insteadof" => instead_of.push((entry.value.clone(), base)),
            "pushinsteadof" => push_instead_of.push((entry.value.clone(), base)),
            _ => {}
        }
    }
    let mut remotes: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
    let mut parents = BTreeMap::new();
    for entry in &local {
        let Some(subsection) = entry.subsection.as_ref() else {
            continue;
        };
        match (entry.section.as_str(), entry.key.as_str()) {
            ("remote", "url") => {
                let remote = remotes.entry(subsection.clone()).or_default();
                remote.0.get_or_insert_with(|| entry.value.clone());
            }
            ("remote", "pushurl") => {
                let remote = remotes.entry(subsection.clone()).or_default();
                remote.1.get_or_insert_with(|| entry.value.clone());
            }
            ("branch", "machdoch-parent") if !entry.value.trim().is_empty() => {
                parents.insert(subsection.clone(), entry.value.trim().to_string());
            }
            _ => {}
        }
    }
    RepositoryConfig {
        remotes: remotes
            .into_iter()
            .filter(|(_, (url, push))| url.is_some() || push.is_some())
            .map(|(name, (url, push_url))| {
                let fetch_url = url.as_deref().map(|url| rewrite(url, &instead_of));
                let push_url = match push_url {
                    Some(push) => Some(rewrite(&push, &instead_of)),
                    None => url.as_deref().map(|url| {
                        let pushed = rewrite(url, &push_instead_of);
                        if pushed == url {
                            rewrite(url, &instead_of)
                        } else {
                            pushed
                        }
                    }),
                };
                WorkspaceGitRemote {
                    name,
                    fetch_url,
                    push_url,
                }
            })
            .collect(),
        parents,
    }
}

pub(super) fn read_repository_config(repository: &Path) -> RepositoryConfig {
    let Some(directories) = git_directories(repository) else {
        return RepositoryConfig::default();
    };
    let mut local = read_entries(&directories.common_dir.join("config"));
    if directories.git_dir != directories.common_dir {
        local.extend(read_entries(&directories.git_dir.join("config.worktree")));
    }
    let global = global_config_paths()
        .iter()
        .flat_map(|path| read_entries(path))
        .collect();
    repository_config(local, global)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;
    use crate::workspace_git::{parse_remotes, run_required};

    #[test]
    fn parses_quoted_values_comments_and_subsections() {
        let entries = parse_config(
            "[remote \"origin\"]\n\turl = \"https://example.test/a b.git\" # comment\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"feature/x\"]\n\tmachdoch-parent = main ; parent\n[core]\n\tbare\n",
        );
        assert_eq!(entries[0].subsection.as_deref(), Some("origin"));
        assert_eq!(entries[0].value, "https://example.test/a b.git");
        assert_eq!(entries[2].value, "main");
        assert_eq!(entries[3].key, "bare");
        assert_eq!(entries[3].value, "true");
    }

    #[test]
    fn applies_url_rewrites_like_git() {
        let config = repository_config(
            parse_config(
                "[remote \"origin\"]\n\turl = gh:team/app.git\n[remote \"mirror\"]\n\turl = https://example.test/app.git\n\tpushurl = ssh://push.example.test/app.git\n",
            ),
            parse_config("[url \"https://github.com/\"]\n\tinsteadOf = gh:\n\tpushInsteadOf = https://example.test/\n"),
        );
        assert_eq!(
            config.remotes,
            vec![
                WorkspaceGitRemote {
                    name: "mirror".to_string(),
                    fetch_url: Some("https://example.test/app.git".to_string()),
                    push_url: Some("ssh://push.example.test/app.git".to_string()),
                },
                WorkspaceGitRemote {
                    name: "origin".to_string(),
                    fetch_url: Some("https://github.com/team/app.git".to_string()),
                    push_url: Some("https://github.com/team/app.git".to_string()),
                },
            ]
        );
    }

    #[test]
    fn matches_git_remote_and_parent_output_for_a_real_repository() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-workspace-git-config-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("the repository should be created");
        run_required("git", &["init", "-b", "main"], &root).expect("git init should succeed");
        run_required(
            "git",
            &["remote", "add", "origin", "https://example.test/origin.git"],
            &root,
        )
        .expect("origin should be added");
        run_required(
            "git",
            &[
                "remote",
                "add",
                "upstream",
                "https://example.test/upstream.git",
            ],
            &root,
        )
        .expect("upstream should be added");
        run_required(
            "git",
            &[
                "remote",
                "set-url",
                "--push",
                "upstream",
                "https://example.test/push.git",
            ],
            &root,
        )
        .expect("the push URL should be set");
        run_required(
            "git",
            &["config", "branch.feature/x.machdoch-parent", "main"],
            &root,
        )
        .expect("the parent should be set");
        let config = read_repository_config(&root);
        assert_eq!(
            config.remotes,
            parse_remotes(&run_required("git", &["remote", "-v"], &root).expect("remotes"))
        );
        assert_eq!(
            config.parents.get("feature/x").map(String::as_str),
            Some("main")
        );
        let _ = fs::remove_dir_all(root);
    }
}
