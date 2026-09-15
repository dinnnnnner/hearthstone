"""Shared validation stopping rule for new and already-running imitation jobs."""
import math


def stopping_status(baseline, scores, *, patience=3, min_delta=.01, min_epochs=5):
    if type(patience) is not int or patience<1 or type(min_epochs) is not int or min_epochs<1:
        raise ValueError('Stopping patience and minimum epochs must be positive integers')
    if not math.isfinite(min_delta) or min_delta<0:raise ValueError('Invalid stopping min_delta')
    if not all(math.isfinite(score) for score in [baseline,*scores]):raise ValueError('Non-finite validation score')
    reference=best=baseline;best_epoch=stale=0
    for epoch,score in enumerate(scores,1):
        if score<best:best=score;best_epoch=epoch
        if score<reference-min_delta:reference=score;stale=0
        else:stale+=1
    return dict(stop=len(scores)>=min_epochs and stale>=patience,completedEpochs=len(scores),
                staleEpochs=stale,significantReference=reference,bestNll=best,bestEpoch=best_epoch,
                patience=patience,minDelta=min_delta,minEpochs=min_epochs)
