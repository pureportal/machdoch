if [ -n "$MACHDOCH_LOGIN_SHELL" ]; then
  unset MACHDOCH_LOGIN_SHELL
  [ -r /etc/profile ] && . /etc/profile
  for __machdoch_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$__machdoch_profile" ]; then
      . "$__machdoch_profile"
      break
    fi
  done
  unset __machdoch_profile
elif [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

if [ -z "$__machdoch_shell_integration" ]; then
  __machdoch_shell_integration=1

  __machdoch_escape() {
    local value="${1//\\/\\\\}"
    value="${value//;/\\x3b}"
    printf '%s' "${value//$'\n'/\\x0a}"
  }

  __machdoch_preexec() {
    local command
    command="$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')"
    printf '\e]633;E;%s\a\e]633;C\a' "$(__machdoch_escape "$command")"
  }

  __machdoch_precmd() {
    local code=$?
    printf '\e]633;D;%s\a\e]633;P;Cwd=%s\a' "$code" "$(__machdoch_escape "$PWD")"
    return $code
  }

  PROMPT_COMMAND="__machdoch_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  PS0='$(__machdoch_preexec)'"$PS0"
  PS1='\[\e]633;A\a\]'"$PS1"'\[\e]633;B\a\]'
fi
