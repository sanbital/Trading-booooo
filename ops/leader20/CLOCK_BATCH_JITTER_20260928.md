# Fixed-slot batch delivery jitter

The first slot after executor 152 (22:40 KST) had 20 valid frozen 24-bucket paths,
331.34419204 USDT and two available slots. No DeepSeek or GPT call was created.
The two observer requests reached generator 44 around 13:40:26 UTC; their batch
claim requests arrived at 13:40:31.442 and 13:40:31.698. The existing SQL guard
returned CLOCK_BATCH_NOT_DUE after 30 seconds. This is separate from the repaired
clock FINAL authority problem and is not an AI WAIT/SKIP.

Allow batch admission during the first 60 seconds, leaving the final minute for
DeepSeek, GPT and execution. Original slot identity, 120-second entry expiry,
capacity, fixed capture and one-batch-per-slot checks remain unchanged. Generator
responses now include the batch admission reason so this cannot appear as an
unexplained successful empty response. No historical slot is replayed.

The PostgreSQL regression reproduces rejection at 31.442 seconds before the
migration, then verifies one accepted claim, duplicate rejection, the 60-second
cutoff and unchanged 120-second expiry. The migration edits the current function
definition in place and refuses an unexpected baseline rather than overwriting it.
