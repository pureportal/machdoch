use std::{iter::Peekable, str::Chars};

const TAB_WIDTH: usize = 8;

struct Screen {
    lines: Vec<Vec<char>>,
    top: usize,
    row: usize,
    column: usize,
    saved_cursor: (usize, usize),
    rows: usize,
    columns: usize,
}

impl Screen {
    fn new(rows: usize, columns: usize) -> Self {
        Self {
            lines: Vec::new(),
            top: 0,
            row: 0,
            column: 0,
            saved_cursor: (0, 0),
            rows,
            columns,
        }
    }

    fn bottom(&self) -> usize {
        self.top + self.rows - 1
    }

    fn current_line(&mut self) -> &mut Vec<char> {
        if self.lines.len() <= self.row {
            self.lines.resize(self.row + 1, Vec::new());
        }
        &mut self.lines[self.row]
    }

    fn print(&mut self, character: char) {
        if self.column >= self.columns {
            self.line_feed();
            self.column = 0;
        }
        let column = self.column;
        let line = self.current_line();
        if line.len() <= column {
            line.resize(column + 1, ' ');
        }
        line[column] = character;
        self.column += 1;
    }

    fn line_feed(&mut self) {
        self.row += 1;
        if self.row > self.bottom() {
            self.top = self.row + 1 - self.rows;
        }
    }

    fn reverse_index(&mut self) {
        if self.row > self.top {
            self.row -= 1;
        } else {
            self.insert_lines(1);
        }
    }

    fn move_to(&mut self, row: usize, column: usize) {
        self.row = self.top + row.min(self.rows - 1);
        self.column = column.min(self.columns - 1);
    }

    fn save_cursor(&mut self) {
        self.saved_cursor = (self.row - self.top, self.column);
    }

    fn restore_cursor(&mut self) {
        let (row, column) = self.saved_cursor;
        self.move_to(row, column);
    }

    fn erase_line(&mut self, mode: usize) {
        let column = self.column;
        let line = self.current_line();
        match mode {
            0 => line.truncate(column),
            1 => line.iter_mut().take(column + 1).for_each(|cell| *cell = ' '),
            _ => line.clear(),
        }
    }

    fn erase_display(&mut self, mode: usize) {
        match mode {
            0 => {
                self.erase_line(0);
                let first_below = self.row + 1;
                self.clear_lines(first_below, self.lines.len());
            }
            1 => {
                self.erase_line(1);
                self.clear_lines(self.top, self.row);
            }
            3 => {
                let removed = self.top.min(self.lines.len());
                self.lines.drain(..removed);
                self.row -= self.top;
                self.top = 0;
            }
            _ => self.clear_lines(self.top, self.lines.len()),
        }
    }

    fn clear_lines(&mut self, start: usize, end: usize) {
        let end = end.min(self.lines.len());
        if start < end {
            self.lines[start..end].iter_mut().for_each(Vec::clear);
        }
    }

    fn erase_characters(&mut self, count: usize) {
        let column = self.column;
        let line = self.current_line();
        line.iter_mut()
            .skip(column)
            .take(count)
            .for_each(|cell| *cell = ' ');
    }

    fn delete_characters(&mut self, count: usize) {
        let column = self.column;
        let line = self.current_line();
        if column < line.len() {
            let end = (column + count).min(line.len());
            line.drain(column..end);
        }
    }

    fn insert_characters(&mut self, count: usize) {
        let column = self.column;
        let line = self.current_line();
        if column < line.len() {
            line.splice(column..column, std::iter::repeat_n(' ', count));
        }
    }

    fn insert_lines(&mut self, count: usize) {
        let bottom = self.bottom();
        for _ in 0..count {
            self.current_line();
            self.lines.insert(self.row, Vec::new());
            if self.lines.len() > bottom + 1 {
                self.lines.remove(bottom + 1);
            }
        }
    }

    fn delete_lines(&mut self, count: usize) {
        let bottom = self.bottom();
        for _ in 0..count {
            if self.row < self.lines.len() {
                self.lines.remove(self.row);
                if self.lines.len() > bottom {
                    self.lines.insert(bottom, Vec::new());
                }
            }
        }
    }

    fn scroll_up(&mut self, count: usize) {
        self.top += count;
        self.row += count;
    }

    fn text_lines(self) -> impl Iterator<Item = String> {
        self.lines.into_iter().map(|line| {
            let text = line.into_iter().collect::<String>();
            text.trim_end().to_string()
        })
    }
}

struct Terminal {
    main: Screen,
    alternate: Option<Screen>,
}

impl Terminal {
    fn screen(&mut self) -> &mut Screen {
        self.alternate.as_mut().unwrap_or(&mut self.main)
    }

    fn process(&mut self, characters: &mut Peekable<Chars<'_>>) {
        while let Some(character) = characters.next() {
            match character {
                '\u{1b}' => self.escape(characters),
                '\n' | '\u{b}' | '\u{c}' => self.screen().line_feed(),
                '\r' => self.screen().column = 0,
                '\u{8}' => {
                    let screen = self.screen();
                    screen.column = screen.column.saturating_sub(1);
                }
                '\t' => {
                    let screen = self.screen();
                    let next_stop = (screen.column / TAB_WIDTH + 1) * TAB_WIDTH;
                    screen.column = next_stop.min(screen.columns - 1);
                }
                other if other.is_control() => {}
                other => self.screen().print(other),
            }
        }
    }

    fn escape(&mut self, characters: &mut Peekable<Chars<'_>>) {
        match characters.next() {
            Some('[') => self.control_sequence(characters),
            Some(']' | 'P' | 'X' | '^' | '_') => skip_string_sequence(characters),
            Some('(' | ')' | '*' | '+' | '%' | '#' | ' ') => {
                characters.next();
            }
            Some('7') => self.screen().save_cursor(),
            Some('8') => self.screen().restore_cursor(),
            Some('M') => self.screen().reverse_index(),
            Some('c') => {
                let (rows, columns) = (self.main.rows, self.main.columns);
                self.alternate = None;
                self.main = Screen::new(rows, columns);
            }
            _ => {}
        }
    }

    fn control_sequence(&mut self, characters: &mut Peekable<Chars<'_>>) {
        let mut parameters = String::new();
        let final_byte = loop {
            match characters.next() {
                Some(next) if ('@'..='~').contains(&next) => break next,
                Some(next) => parameters.push(next),
                None => return,
            }
        };
        if let Some(modes) = parameters.strip_prefix('?') {
            if modes
                .split(';')
                .any(|mode| matches!(mode, "47" | "1047" | "1049"))
            {
                self.switch_screen(final_byte);
            }
            return;
        }
        if parameters.starts_with(|next: char| !next.is_ascii_digit() && next != ';') {
            return;
        }
        let values = parameters
            .split(';')
            .map(|value| value.parse::<usize>().unwrap_or(0))
            .collect::<Vec<_>>();
        let first = values.first().copied().unwrap_or(0);
        let count = first.max(1);
        let screen = self.screen();
        match final_byte {
            'A' => screen.row = screen.row.saturating_sub(count).max(screen.top),
            'B' => screen.row = (screen.row + count).min(screen.bottom()),
            'C' => screen.column = (screen.column + count).min(screen.columns - 1),
            'D' => screen.column = screen.column.saturating_sub(count),
            'E' => {
                screen.row = (screen.row + count).min(screen.bottom());
                screen.column = 0;
            }
            'F' => {
                screen.row = screen.row.saturating_sub(count).max(screen.top);
                screen.column = 0;
            }
            'G' | '`' => screen.column = (count - 1).min(screen.columns - 1),
            'd' => screen.row = screen.top + (count - 1).min(screen.rows - 1),
            'H' | 'f' => {
                let column = values.get(1).copied().unwrap_or(0).max(1);
                screen.move_to(count - 1, column - 1);
            }
            'J' => screen.erase_display(first),
            'K' => screen.erase_line(first),
            'X' => screen.erase_characters(count),
            'P' => screen.delete_characters(count),
            '@' => screen.insert_characters(count),
            'L' => screen.insert_lines(count),
            'M' => screen.delete_lines(count),
            'S' => screen.scroll_up(count),
            's' => screen.save_cursor(),
            'u' => screen.restore_cursor(),
            _ => {}
        }
    }

    fn switch_screen(&mut self, final_byte: char) {
        match final_byte {
            'h' if self.alternate.is_none() => {
                self.alternate = Some(Screen::new(self.main.rows, self.main.columns));
            }
            'l' => self.alternate = None,
            _ => {}
        }
    }
}

fn skip_string_sequence(characters: &mut Peekable<Chars<'_>>) {
    while let Some(next) = characters.next() {
        if next == '\u{7}' {
            return;
        }
        if next == '\u{1b}' && characters.peek() == Some(&'\\') {
            characters.next();
            return;
        }
    }
}

pub(super) fn render_terminal_text(output: &[u8], columns: u16, rows: u16) -> Vec<String> {
    let decoded = String::from_utf8_lossy(output);
    let (rows, columns) = (usize::from(rows.max(1)), usize::from(columns.max(1)));
    let mut terminal = Terminal {
        main: Screen::new(rows, columns),
        alternate: None,
    };
    terminal.process(&mut decoded.chars().peekable());
    let Terminal { main, alternate } = terminal;
    let mut lines = main.text_lines().collect::<Vec<_>>();
    if let Some(alternate) = alternate {
        lines.extend(alternate.text_lines());
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::render_terminal_text;

    fn render(output: &str) -> Vec<String> {
        render_terminal_text(output.as_bytes(), 40, 4)
    }

    #[test]
    fn keeps_plain_output_and_removes_styling() {
        assert_eq!(
            render("\u{1b}[32mok\u{1b}[0m done\r\nnext\r\n"),
            ["ok done", "next"]
        );
    }

    #[test]
    fn scrolled_lines_stay_readable_above_the_viewport() {
        let output = (0..8)
            .map(|index| format!("line-{index}\r\n"))
            .collect::<String>();
        let lines = render(&output);
        assert_eq!(lines.len(), 8);
        assert_eq!(lines[0], "line-0");
        assert_eq!(lines[7], "line-7");
    }

    #[test]
    fn repainted_prompts_show_their_final_text() {
        assert_eq!(
            render("PS> g\r\u{1b}[KPS> gi\r\u{1b}[KPS> git status\u{1b}[?25h"),
            ["PS> git status"]
        );
    }

    #[test]
    fn absolute_cursor_addressing_targets_the_viewport() {
        assert_eq!(
            render("\u{1b}[2J\u{1b}[1;1Hfirst\u{1b}[2;1Hsecond\u{1b}[1;7H!"),
            ["first !", "second"]
        );
    }

    #[test]
    fn progress_rewrites_replace_the_previous_value() {
        assert_eq!(render("10%\r50%\r100%\r\ndone"), ["100%", "done"]);
    }

    #[test]
    fn long_lines_wrap_at_the_terminal_width() {
        assert_eq!(
            render_terminal_text("abcdefgh".as_bytes(), 4, 4),
            ["abcd", "efgh"]
        );
    }

    #[test]
    fn closed_alternate_screens_do_not_pollute_the_history() {
        assert_eq!(
            render("before\r\n\u{1b}[?1049hfullscreen app\u{1b}[?1049lafter"),
            ["before", "after"]
        );
    }

    #[test]
    fn open_alternate_screens_follow_the_main_history() {
        assert_eq!(
            render("before\r\n\u{1b}[?1049hvim"),
            ["before", "vim"]
        );
    }

    #[test]
    fn title_sequences_and_split_escapes_do_not_produce_text() {
        assert_eq!(render("\u{1b}]0;title\u{7}shown\u{1b}["), ["shown"]);
    }

    #[test]
    fn invalid_utf8_does_not_fail_rendering() {
        assert_eq!(
            render_terminal_text(&[b'a', 0xff, b'b'], 40, 4),
            ["a\u{fffd}b"]
        );
    }

    #[test]
    fn line_insertion_and_deletion_stay_in_bounds() {
        assert_eq!(render("a\r\nb\u{1b}[1;1H\u{1b}[L"), ["", "a", "b"]);
        assert_eq!(render("a\r\nb\u{1b}[1;1H\u{1b}[M"), ["b"]);
        assert_eq!(render("\u{1b}[4;1H\u{1b}[L\u{1b}[M\u{1b}M"), Vec::<String>::new());
    }
}
