# Phase 11: production SSM cutover

Completed on 2026-09-29 against EC2 `i-064bf5ab807b500be` (`65.2.123.254`), repository `/opt/lookmefy`.

## Starting state and rollback

At first inspection, `/opt/lookmefy/.env` was already absent, despite the stated starting state. The original dotenv data was present at `/opt/lookmefy/.env.disabled` (`0600`, `ubuntu:ubuntu`). Its 114 unique variable names matched the 114 names in the existing SSM-generated environment file. Both services were active, and local and public readiness were HTTP 200 with MongoDB, Redis, and queue ready.

Before changing the units, the original dotenv data and previous SSM files were copied into the root-only directory `/etc/lookmefy/phase11-rollback-20260929` (`0700`). The protected `.env` copy is `0600`, `root:root`. The exact rollback command is:

```bash
sudo /etc/lookmefy/phase11-rollback-20260929/rollback.sh
```

That script restores `/opt/lookmefy/.env` first, removes both SSM drop-ins and the loader unit, reloads systemd, restarts backend and worker, and checks local and public readiness. It retains the protected dotenv copies.

## Deployment commands

The following commands were run on the EC2 host after staging the files at `/tmp/lookmefy-phase11-stage`. The application `ExecStart` lines remained `/usr/bin/npm run server` and `/usr/bin/npm run worker`.

```bash
stage=/tmp/lookmefy-phase11-stage
sudo install -o root -g root -m 0750 "$stage/lookmefy-load-ssm.sh" /usr/local/bin/lookmefy-load-ssm.sh
sudo install -o root -g root -m 0644 "$stage/expected-keys.txt" /etc/lookmefy/ssm-expected-keys
sudo install -o root -g root -m 0644 "$stage/lookmefy-load-ssm.service" /etc/systemd/system/lookmefy-load-ssm.service
sudo install -o root -g root -m 0644 "$stage/lookmefy-backend-ssm.conf" /etc/systemd/system/lookmefy-backend.service.d/ssm.conf
sudo install -o root -g root -m 0644 "$stage/lookmefy-worker-ssm.conf" /etc/systemd/system/lookmefy-worker.service.d/ssm.conf
sudo install -o root -g root -m 0644 "$stage/worker-role.env" /etc/lookmefy/worker-role.env
sudo systemd-analyze verify /etc/systemd/system/lookmefy-load-ssm.service /etc/systemd/system/lookmefy-backend.service /etc/systemd/system/lookmefy-worker.service
sudo /usr/local/bin/lookmefy-load-ssm.sh
sudo systemctl daemon-reload
sudo systemctl start lookmefy-load-ssm.service
```

The installed rollback and guarded backend scripts are copies of `rollback-phase11.sh` and `cutover-backend.sh` in the protected directory. After the first rollback, the final cutover ran:

```bash
rollback=/etc/lookmefy/phase11-rollback-20260929
sudo mv /opt/lookmefy/.env "$rollback/.env.from-opt"
sudo chown root:root "$rollback/.env.from-opt"
sudo chmod 0600 "$rollback/.env.from-opt"
sudo cmp -s "$rollback/.env" "$rollback/.env.from-opt"
sudo "$rollback/cutover-backend.sh"
sudo systemctl restart lookmefy-worker.service
```

The backend script restarts only the backend, checks active state and local and public readiness including MongoDB, Redis, and queue, and calls the rollback script on failure. The worker restart was followed by an active-state check and a journal check for `worker_started` and startup error lines.

## Verification and incident during cutover

- `systemd-analyze verify`: passed before each cutover attempt.
- Loader: `Result=success`, `ExecMainStatus=0`; all 114 names were unique and exactly matched `expected-keys.txt`. No parameter values were printed.
- `/run/lookmefy`: `0700`, `root:root`; `/run/lookmefy/ssm.env`: `0600`, `root:root`.
- A transient systemd role probe using both worker environment files confirmed `APP_ROLE=worker` without printing any environment values.
- The first worker restart exited with status 1 because SSM's `APP_ROLE` overrode the worker unit's role. The automatic rollback restored `.env` and the original dotenv-based service configuration. Both services and both readiness endpoints were verified healthy before the retry. The worker drop-in was then corrected with a final, required `/etc/lookmefy/worker-role.env` file.
- Final backend cutover: backend active; local MongoDB, Redis, and queue ready; public readiness true.
- Final worker cutover: worker active; one `worker_started` event and zero startup error lines.
- Final state: backend and worker active, `/opt/lookmefy/.env` absent, local and public readiness true, protected rollback copies retained.
- An independent request to `https://api.lookmefy.in/api/health/ready` from the operator machine also returned readiness true with MongoDB, Redis, and queue ready.

## IAM commands and final state

The prior `LookmefyReadProductionSSM` policy was saved locally before modification. The final read policy is `lookmefy-prod-ssm-read-policy.json`, allowing only `ssm:GetParametersByPath` on `/lookmefy/prod` and descendants. These commands were run from the operator machine:

```bash
aws iam put-role-policy --role-name lookmefy-prod-ec2-role --policy-name LookmefyReadProductionSSM --policy-document file://deployment/ssm/lookmefy-prod-ssm-read-policy.json
aws iam delete-role-policy --role-name lookmefy-prod-ec2-role --policy-name LookmefyTemporarySSMWrite
```

After both IAM changes, the loader succeeded again with all 114 exact variables and both services remained active. `aws iam list-role-policies` returned only `LookmefyReadProductionSSM`. IAM simulation returned `allowed` for `ssm:GetParametersByPath` on `/lookmefy/prod` and `implicitDeny` for `ssm:PutParameter` on the same path.
