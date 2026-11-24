__machdoch_integration_dir="$ZDOTDIR"
ZDOTDIR="${MACHDOCH_USER_ZDOTDIR:-$HOME}"
[ -r "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"

if [ -z "$__machdoch_shell_integration" ]; then
  __machdoch_shell_integration=1

  __machdoch_escape() {
    local value="${1//\\/\\\\}"
    value="${value//;/\\x3b}"
    print -rn -- "${value//$'\n'/\\x0a}"
  }

  __machdoch_precmd() {
    local code=$?
    print -n "\e]633;D;$code\a\e]633;P;Cwd=$(__machdoch_escape "$PWD")\a"
  }

  __machdoch_preexec() {
    print -n "\e]633;E;$(__machdoch_escape "$1")\a\e]633;C\a"
  }

  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __machdoch_precmd
  add-zsh-hook preexec __machdoch_preexec
  PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'
fi
unset __machdoch_integration_dir
