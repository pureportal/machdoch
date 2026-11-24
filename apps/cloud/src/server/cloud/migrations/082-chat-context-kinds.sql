ALTER TABLE cloud_chat_context DROP CONSTRAINT cloud_chat_context_kind_check;
ALTER TABLE cloud_chat_context ADD CONSTRAINT cloud_chat_context_kind_check
  CHECK (kind IN ('issue','project','cycle','team','pull_request','view','release','loop','document','repository'));
