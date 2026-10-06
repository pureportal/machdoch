pub fn valid_uuid(id: &str) -> bool {
    if id == "00000000-0000-0000-0000-000000000000" || id == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}
