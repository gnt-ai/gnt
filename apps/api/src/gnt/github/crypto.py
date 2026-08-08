from gnt.crypto import make_token_cipher

encrypt_token, decrypt_token = make_token_cipher("github_pat_encryption_key")
