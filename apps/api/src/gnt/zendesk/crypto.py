from gnt.crypto import make_token_cipher

encrypt_token, decrypt_token = make_token_cipher("zendesk_token_encryption_key")
