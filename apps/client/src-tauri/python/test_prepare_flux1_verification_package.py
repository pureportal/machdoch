import unittest

from prepare_flux1_verification_package import flux_dev_distribution_notice


class FluxDevNoticeTests(unittest.TestCase):
    def test_preserves_required_attribution_and_identifies_conversion(self):
        attribution = (
            "The FLUX.1 [dev] Model is licensed by Black Forest Labs Inc. under the "
            "FLUX.1 [dev] Non-Commercial License. Copyright Black Forest Labs Inc.\n"
            "IN NO EVENT SHALL BLACK FOREST LABS INC. BE LIABLE FOR ANY CLAIM, DAMAGES "
            "OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, "
            "ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL."
        )
        notice = flux_dev_distribution_notice("Distribution attribution:\n“" + attribution + "”\n")
        self.assertTrue(notice.startswith(attribution + "\n\n"))
        self.assertIn("converted the Civitai checkpoint", notice)
        self.assertIn("no fine-tuning was performed", notice)
        self.assertIn("not endorsed by Black Forest Labs", notice)

    def test_rejects_a_missing_attribution_instead_of_generating_one(self):
        with self.assertRaisesRegex(ValueError, "attribution notice is missing"):
            flux_dev_distribution_notice("Different publisher agreement")


if __name__ == "__main__":
    unittest.main()
