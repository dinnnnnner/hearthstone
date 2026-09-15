import datetime
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from tavern_rl.imitation_stopping import stopping_status
from tavern_rl.imitate_fresh import fresh_trial
import test_imitation_fresh as fixtures


class ImitationStoppingTests(unittest.TestCase):
    def test_plateau_stops_after_minimum_epochs(self):
        self.assertFalse(stopping_status(3.,[2.,2.1,2.2,2.3])['stop'])
        result=stopping_status(3.,[2.,2.1,2.2,2.3,2.4])
        self.assertTrue(result['stop']);self.assertEqual(result['bestEpoch'],1)

    def test_ongoing_improvement_and_recovery_keep_training(self):
        self.assertFalse(stopping_status(3.,[2.8,2.6,2.4,2.2,2.])['stop'])
        result=stopping_status(3.,[2.,2.1,2.2,1.9,1.91])
        self.assertFalse(result['stop']);self.assertEqual(result['staleEpochs'],1)

    def test_small_improvement_keeps_best_without_resetting_patience(self):
        result=stopping_status(3.,[2.,1.998,1.997,1.996,1.995])
        self.assertTrue(result['stop']);self.assertEqual(result['bestEpoch'],5)
        self.assertEqual(result['significantReference'],2.)

    def test_small_improvements_accumulate_into_significant_progress(self):
        result=stopping_status(3.,[2.,1.996,1.992,1.988,1.984])
        self.assertFalse(result['stop']);self.assertEqual(result['staleEpochs'],1)

    def test_nonfinite_scores_and_invalid_settings_are_rejected(self):
        for kwargs in [dict(patience=0),dict(min_epochs=0),dict(min_delta=-1),dict(min_delta=float('nan'))]:
            with self.assertRaises(ValueError):stopping_status(3.,[],**kwargs)
        with self.assertRaises(ValueError):stopping_status(3.,[float('nan')])

    def test_training_stops_and_retains_best_epoch(self):
        data=fixtures.FreshImitationTests().data()
        values=[dict(all=dict(negative_log_likelihood=v)) for v in [3.,2.,2.1,2.2,2.3,2.4]]
        deadline=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=3)).isoformat()
        with tempfile.TemporaryDirectory() as tmp,patch('tavern_rl.imitate_fresh.load_dataset',return_value=data), \
             patch('tavern_rl.imitate_fresh.evaluate',side_effect=values):
            report=fresh_trial('unused',Path(tmp)/'trial',deadline,depth=4,hidden=16,heads=2,layers=1,
                               batch_size=2,sequence_length=2,max_epochs=20)
            self.assertEqual(report['stopReason'],'validation_patience')
            self.assertEqual(report['epoch'],5);self.assertEqual(report['bestEpoch'],1)
            self.assertTrue(report['stopping']['stop'])


if __name__=='__main__':unittest.main()
