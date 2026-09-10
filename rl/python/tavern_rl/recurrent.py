"""Sequence PPO: per-player GAE, ordered chunks, burn-in and padding-aware losses."""
import numpy as np
import torch
from torch import nn
from .model import advantages


def recurrent_update(model, optimizer, tracks, config, device):
    length = config.get('sequence_length', 16)
    burn = config.get('burn_in', 8)
    batch_size = config.get('sequence_batch_size', 4)
    chunks, all_adv = [], []
    for records, reward in tracks:
        if not records: continue
        adv, returns = advantages([r[4] for r in records], reward, config['gamma'], config['gae_lambda'])
        all_adv.extend(adv)
        for start in range(0,len(records),length):
            end = min(start+length,len(records)); initial = max(0,start-burn)
            chunks.append((records[initial:start], records[start:end], records[initial][5], adv[start:end], returns[start:end]))
    if not chunks: raise RuntimeError('No complete recurrent trajectories')
    center, spread = float(np.mean(all_adv)), float(np.std(all_adv)) + 1e-8
    stats, stopped = [], False
    model.train()
    for _ in range(config['epochs']):
        order = torch.randperm(len(chunks)).tolist()
        for offset in range(0,len(order),batch_size):
            batch = [chunks[i] for i in order[offset:offset+batch_size]]
            count = len(batch)
            memory = torch.as_tensor(np.stack([item[2] for item in batch]),dtype=torch.float32,device=device)
            burn_length = max(len(item[0]) for item in batch)
            if burn_length:
                observations = [item[0][t][0] if t < len(item[0]) else None for item in batch for t in range(burn_length)]
                with torch.no_grad():
                    encoded = model.encode(observations,device).reshape(count,burn_length,model.schema['count'],model.hidden)
                    for t in range(burn_length):
                        valid = torch.tensor([t < len(item[0]) for item in batch],device=device)
                        previous = torch.tensor([item[0][t][6] if t < len(item[0]) else model.action_size for item in batch],device=device)
                        updated = model.recurrent_step(encoded[:,t],memory,previous)
                        memory = torch.where(valid[:,None],updated,memory)
            sequence_length = max(len(item[1]) for item in batch)
            observations, masks, actions, old_logs, advs, targets, previous, valid = [], [], [], [], [], [], [], []
            for item in batch:
                for t in range(sequence_length):
                    live = t < len(item[1]); valid.append(live)
                    if live:
                        record = item[1][t]
                        observations.append(record[0]); masks.append(record[1]); actions.append(record[2]); old_logs.append(record[3])
                        advs.append((item[3][t]-center)/spread); targets.append(item[4][t]); previous.append(record[6])
                    else:
                        mask = np.zeros(model.action_size,dtype=np.bool_); mask[0] = True
                        observations.append(None); masks.append(mask); actions.append(0); old_logs.append(0.)
                        advs.append(0.); targets.append(0.); previous.append(model.action_size)
            valid = torch.tensor(valid,dtype=torch.bool,device=device).reshape(count,sequence_length)
            encoded = model.encode(observations,device).reshape(count,sequence_length,model.schema['count'],model.hidden)
            previous = torch.tensor(previous,device=device).reshape(count,sequence_length)
            states = []
            for t in range(sequence_length):
                updated = model.recurrent_step(encoded[:,t],memory,previous[:,t])
                memory = torch.where(valid[:,t,None],updated,memory)
                states.append(memory)
            legal = torch.as_tensor(np.stack(masks),device=device)
            distribution, value = model.distribution_from(encoded.flatten(0,1),torch.stack(states,1).flatten(0,1),legal)
            take = valid.flatten()
            chosen = torch.tensor(actions,device=device)
            old = torch.tensor(old_logs,device=device)
            advantage = torch.tensor(advs,dtype=torch.float32,device=device)
            target = torch.tensor(targets,dtype=torch.float32,device=device)
            log_ratio = (distribution.log_prob(chosen)-old)[take]
            ratio = log_ratio.exp()
            kl = ((ratio-1)-log_ratio).mean().detach()
            if kl > 1.5*config['target_kl']: stopped = True; break
            policy_loss = -torch.minimum(ratio*advantage[take],ratio.clamp(1-config['clip'],1+config['clip'])*advantage[take]).mean()
            value_loss = (value[take]-target[take]).square().mean()
            entropy = distribution.entropy()[take].mean()
            loss = policy_loss + config['value_coef']*value_loss - config['entropy_coef']*entropy
            if not torch.isfinite(loss): raise RuntimeError('Non-finite recurrent PPO loss')
            optimizer.zero_grad(set_to_none=True); loss.backward()
            norm = nn.utils.clip_grad_norm_(model.parameters(),config['max_grad_norm'],error_if_nonfinite=True)
            optimizer.step()
            stats.append([float(policy_loss.detach()),float(value_loss.detach()),float(entropy.detach()),float(kl),float(norm)])
        if stopped: break
    if not stats: raise RuntimeError('Recurrent PPO performed no optimizer updates')
    return dict(zip(['policy_loss','value_loss','entropy','approx_kl','gradient_norm'],np.mean(stats,axis=0).tolist())) | {
        'samples':len(all_adv),'optimizer_steps':len(stats),'kl_early_stop':stopped,'sequence_chunks':len(chunks)}
