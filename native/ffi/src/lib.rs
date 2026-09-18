//! Small ownership-explicit C/Wasm ABI. Both hosts use the same compiled rules crate.
const MAX_BYTES: usize = 32 * 1024 * 1024;
#[unsafe(no_mangle)]
pub extern "C" fn tavern_abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn tavern_alloc(len: usize) -> *mut u8 {
    if len == 0 || len > MAX_BYTES {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}
/// # Safety
/// `ptr` must come from this module and `len` must equal its original allocation size.
/// The caller must not use the pointer after this call, or free it a second time.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tavern_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe {
            drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
        }
    }
}
/// # Safety
/// The input must reference `len` initialized bytes allocated with `tavern_alloc`.
/// Returns an owned buffer: four-byte little-endian payload length followed by UTF-8 JSON.
/// Caller owns both allocations and must free each one using its exact total length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tavern_request(ptr: *const u8, len: usize) -> *mut u8 {
    let reply = if ptr.is_null() || len == 0 || len > MAX_BYTES {
        br#"{"ok":false,"error":"Invalid request buffer"}"#.to_vec()
    } else {
        let input = unsafe { std::slice::from_raw_parts(ptr, len) };
        std::panic::catch_unwind(|| tavern_rules::request(input))
            .unwrap_or_else(|_| br#"{"ok":false,"error":"Native rule invariant failed"}"#.to_vec())
    };
    if reply.len() + 4 > MAX_BYTES {
        return std::ptr::null_mut();
    }
    let mut buffer = Vec::with_capacity(reply.len() + 4);
    buffer.extend_from_slice(&(reply.len() as u32).to_le_bytes());
    buffer.extend_from_slice(&reply);
    Box::into_raw(buffer.into_boxed_slice()) as *mut u8
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe fn roundtrip(input: &[u8]) -> serde_json::Value {
        unsafe {
            let ptr = tavern_alloc(input.len());
            assert!(!ptr.is_null());
            std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
            let reply = tavern_request(ptr, input.len());
            assert!(!reply.is_null());
            let len = u32::from_le_bytes(std::slice::from_raw_parts(reply, 4).try_into().unwrap())
                as usize;
            let result =
                serde_json::from_slice(std::slice::from_raw_parts(reply.add(4), len)).unwrap();
            tavern_free(reply, len + 4);
            tavern_free(ptr, input.len());
            result
        }
    }
    #[test]
    fn request_ownership_repeated_and_unicode() {
        for n in 0..1000 {
            let request=serde_json::to_vec(&serde_json::json!({"command":"makeMinion","id":"s14_BG25_001","uid":format!("随从-{n}"),"golden":false,"fromPool":true})).unwrap();
            let r = unsafe { roundtrip(&request) };
            assert_eq!(r["ok"], true);
            assert_eq!(r["result"]["uid"], format!("随从-{n}"));
        }
    }
    #[test]
    fn invalid_input_is_structured_and_does_not_poison_next_request() {
        assert!(tavern_alloc(0).is_null());
        assert!(tavern_alloc(MAX_BYTES + 1).is_null());
        for bytes in [b"{".as_slice(), b"\xff", br#"{"command":"missing"}"#] {
            let reply = unsafe { roundtrip(bytes) };
            assert_eq!(reply["ok"], false);
            assert!(reply["error"].is_string());
            assert_eq!(unsafe { roundtrip(br#"{"command":"meta"}"#) }["ok"], true);
        }
    }
    #[test]
    fn incomplete_full_game_is_never_accepted() {
        for command in ["reset", "step", "action", "combat", "restore", "snapshot"] {
            let request = serde_json::to_vec(&serde_json::json!({"command":command})).unwrap();
            let r = unsafe { roundtrip(&request) };
            assert_eq!(r["ok"], false);
            assert!(
                r["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("RUST_ENGINE_INCOMPLETE")
            );
        }
    }
    #[test]
    fn invalid_states_do_not_abort_runtime() {
        for command in ["offerTrinkets", "equipPowers", "syncStats", "powerState"] {
            for state in [
                serde_json::Value::Null,
                serde_json::json!({}),
                serde_json::json!({"season":[]}),
            ] {
                let input =
                    serde_json::to_vec(&serde_json::json!({"command":command,"state":state}))
                        .unwrap();
                let reply = unsafe { roundtrip(&input) };
                assert_eq!(reply["ok"], false);
                assert_eq!(
                    reply["error"],
                    "Native rule operation requires a season state"
                );
            }
        }
    }
}
