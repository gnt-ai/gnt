from gnt.crypto import make_token_cipher
from gnt.gitlab.oauth import GitlabNotConfiguredError

encrypt_token, decrypt_token = make_token_cipher(
    "gitlab_token_encryption_key", not_configured_error=GitlabNotConfiguredError
)
