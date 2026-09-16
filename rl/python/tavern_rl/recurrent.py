"""Recurrent return regression / PPO with ordered chunks and burn-in."""
import numpy as np
import torch
from torch import nn
from .model import advantages


def recurrent_update(model, optimizer, tracks, config, device):
    search_mode=bool(config.get('gold_planning',{}).get('direct'))
    q_mode=bool(config.get('action_value'))
    if q_mode != hasattr(model,'action_value_type') or (q_mode and search_mode):
        raise ValueError('Action-value architecture requires its return-regression update')
    length = config.get('sequence_length', 16)
    burn = config.get('burn_in', 8)
    batch_size = config.get('sequence_batch_size', 4)
    chunks, all_adv = [], []
    for records, reward in tracks:
        if not records: continue
        if any((len(r)==8)!=search_mode for r in records):
            raise ValueError('Search trajectories require the search-policy/value update, not PPO')
        if search_mode:
            adv=np.zeros(len(records),dtype=np.float32)
            from .stage_feedback import discounted_returns
            returns=discounted_returns(reward,len(records),config['gamma'])
        else:
            adv, returns = advantages([r[4] for r in records], reward['rewards'] if isinstance(reward,dict) else reward,
                config['gamma'], config['gae_lambda'],bootstrap=reward.get('bootstrap',0.) if isinstance(reward,dict) else 0.)
        all_adv.extend(adv)
        for start in range(0,len(records),length):
            end = min(start+length,len(records)); initial = max(0,start-burn)
            aux=reward.get('auxiliary',[None]*len(records)) if isinstance(reward,dict) else [None]*len(records)
            if len(aux)!=len(records):raise ValueError('Auxiliary outcomes differ from trajectory length')
            chunks.append((records[initial:start], records[start:end], records[initial][5], adv[start:end], returns[start:end],aux[start:end]))
    if not chunks: raise RuntimeError('No complete recurrent trajectories')
    center, spread = float(np.mean(all_adv)), float(np.std(all_adv)) + 1e-8
    stats, stopped = [], False
    supervised=sum(r[7] is not None for records,_ in tracks for r in records) if search_mode else 0
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
            teachers=[];auxiliary=[]
            for item in batch:
                for t in range(sequence_length):
                    live = t < len(item[1]); valid.append(live)
                    teachers.append(item[1][t][7] if search_mode and live else None)
                    auxiliary.append(item[5][t] if live else None)
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
            outputs = model.distribution_from(encoded.flatten(0,1),torch.stack(states,1).flatten(0,1),legal,with_action_values=True) if q_mode else model.distribution_from(encoded.flatten(0,1),torch.stack(states,1).flatten(0,1),legal)
            distribution, value = outputs[:2]
            take = valid.flatten()
            chosen = torch.tensor(actions,device=device)
            old = torch.tensor(old_logs,device=device)
            advantage = torch.tensor(advs,dtype=torch.float32,device=device)
            target = torch.tensor(targets,dtype=torch.float32,device=device)
            if q_mode:
                selected=outputs[2].gather(1,chosen[:,None]).squeeze(1)
                policy_loss=nn.functional.smooth_l1_loss(selected[take],target[take])
                kl=value.new_zeros(())
            elif search_mode:
                indices=[i for i,t in enumerate(teachers) if t is not None]
                if indices:
                    width=max(len(teachers[i]['actions']) for i in indices)
                    ids=[];weights=[];allowed=[]
                    for i in indices:
                        teacher=teachers[i];n=len(teacher['actions'])
                        ids.append(teacher['actions']+[0]*(width-n));weights.append(teacher['target']+[0.]*(width-n))
                        allowed.append([True]*n+[False]*(width-n))
                    logits=distribution.logits[indices].gather(1,torch.tensor(ids,device=device))
                    logits=logits.masked_fill(~torch.tensor(allowed,device=device),-1e9)
                    policy_loss=-(torch.log_softmax(logits,dim=1)*torch.tensor(weights,dtype=logits.dtype,device=device)).sum(1).mean()
                else:policy_loss=value.sum()*0
                kl=value.new_zeros(())
            else:
                log_ratio = (distribution.log_prob(chosen)-old)[take]
                ratio = log_ratio.exp()
                kl = ((ratio-1)-log_ratio).mean().detach()
                if kl > 1.5*config['target_kl']: stopped = True; break
                policy_loss = -torch.minimum(ratio*advantage[take],ratio.clamp(1-config['clip'],1+config['clip'])*advantage[take]).mean()
            value_loss = (value[take]-target[take]).square().mean()
            entropy = distribution.entropy()[take].mean()
            loss = policy_loss + config['value_coef']*value_loss
            auxiliary_loss=value.sum()*0
            aux_indices=[i for i,a in enumerate(auxiliary) if a is not None]
            if config.get('streaming') and aux_indices:
                predictions=model.auxiliary(torch.stack(states,1).flatten(0,1)[aux_indices])
                labels=[auxiliary[i] for i in aux_indices]
                combat=torch.tensor([a['combat'] for a in labels],device=device)
                numeric=torch.tensor([[a['damage'],*a['resources']] for a in labels],dtype=predictions.dtype,device=device)
                auxiliary_loss=nn.functional.cross_entropy(predictions[:,:3],combat)+nn.functional.smooth_l1_loss(predictions[:,3:],numeric)
                loss=loss+config['streaming']['auxiliary_coef']*auxiliary_loss
            if not search_mode and not q_mode:loss=loss-config['entropy_coef']*entropy
            if not torch.isfinite(loss): raise RuntimeError('Non-finite recurrent training loss')
            optimizer.zero_grad(set_to_none=True); loss.backward()
            norm = nn.utils.clip_grad_norm_(model.parameters(),config['max_grad_norm'],error_if_nonfinite=True)
            optimizer.step()
            stats.append([float(policy_loss.detach()),float(value_loss.detach()),float(entropy.detach()),float(kl),float(norm),float(auxiliary_loss.detach())])
        if stopped: break
    if not stats: raise RuntimeError('Recurrent training performed no optimizer updates')
    return dict(zip(['policy_loss','value_loss','entropy','approx_kl','gradient_norm','auxiliary_loss'],np.mean(stats,axis=0).tolist())) | {
        'samples':len(all_adv),'optimizer_steps':len(stats),'kl_early_stop':stopped,'sequence_chunks':len(chunks),
        **({'training_mode':'soft_action_value','action_value_loss':float(np.mean(stats,axis=0)[0]),'policy_loss':0.} if q_mode else {}),
        **({'training_mode':'search_policy_value','search_policy_samples':supervised} if search_mode else {})}
