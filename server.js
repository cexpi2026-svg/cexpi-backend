const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(helmet());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}));
const allowedOrigins = [
  "https://cexpi2026-svg.github.io"
];

app.use(cors({
  origin: (origin, callback) => {
    // السماح للطلبات التي لا ترسل Origin (مثل بعض أدوات الاختبار)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS blocked"));
  },
  methods: ["GET", "POST"],
  credentials: false
}));
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// نموذج المستخدم
const UserSchema = new mongoose.Schema({
  piUid: { type: String, required: true, unique: true },
  piUsername: { type: String, required: true },
  country: { type: String, required: true },
  welcomeRewardSent: { type: Boolean, default: false }, // ✅ هذا السطر الجديد
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// نموذج الإعلان
const ListingSchema = new mongoose.Schema({
  sellerUid: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  priceInPi: { type: Number, required: true },
  category: { type: String, required: true },
  make: String,
  model: String,
  year: Number,
  mileage: Number,
  country: { type: String, required: true },
  region: { type: String, required: true },
  images: [String],
  phoneNumber: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  active: { type: Boolean, default: true }
});
const Listing = mongoose.model('Listing', ListingSchema);

// تسجيل المستخدم
app.post('/api/register-user', async (req, res) => {
  const { piUid, piUsername, country } = req.body;
  if (!piUid || !piUsername || !country) return res.status(400).json({ error: 'Missing fields' });

  try {
    await User.findOneAndUpdate({ piUid }, { piUsername, country }, { upsert: true, new: true });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// إنشاء طلب دفع
app.post('/api/create-listing-payment', async (req, res) => {
  const { piUid } = req.body;
  if (!piUid) return res.status(400).json({ error: 'piUid required' });

  res.json({
    success: true,
    amount: 0.5,
    memo: 'CexPi Listing Fee - 0.5 Pi',
    metadata: { type: 'listing_fee', piUid }
  });
});

// موافقة على الدفع
app.post('/api/approve-payment', async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

  try {
    await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {}, {
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` }
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Approve error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// إكمال الدفع
app.post('/api/complete-payment', async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId and txid required' });

  try {
    await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/complete`, { txid }, {
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` }
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Complete error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// نشر الإعلان
app.post('/api/complete-listing', async (req, res) => {
  const { piUid, title, description, priceInPi, category, make, model, year, mileage, country, region, images, phoneNumber } = req.body;

  if (!piUid || !title || !description || !priceInPi || !category || !country || !region || !phoneNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const newListing = new Listing({
      sellerUid: piUid,
      title,
      description,
      priceInPi,
      category,
      make: make || '',
      model: model || '',
      year: year || null,
      mileage: mileage || null,
      country,
      region,
      images: images || [],
      phoneNumber
    });

    await newListing.save();
    res.json({ success: true, message: 'Listing published successfully!' });
  } catch (e) {
    console.error('Save listing error:', e);
    res.status(500).json({ error: e.message || 'Failed to save listing' });
  }
});

// جلب الإعلانات (معدل ليجلب كل الإعلانات بدون شرط country)
app.get('/api/get-listings', async (req, res) => {
  try {
    const listings = await Listing.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, listings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// حذف الإعلان
app.post('/api/delete-listing', async (req, res) => {
  const { listingId, piUid } = req.body;
  if (!listingId || !piUid) return res.status(400).json({ error: 'listingId and piUid required' });

  try {
    const listing = await Listing.findOne({ _id: listingId, sellerUid: piUid });
    if (!listing) return res.status(404).json({ error: 'Listing not found or not owned by you' });

    await Listing.deleteOne({ _id: listingId });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


// ================= A2U PROMO WITHDRAWAL (First 5 Users) =================
const PiNetwork = require('pi-backend').default;
const piSDK = new PiNetwork(process.env.PI_API_KEY, process.env.PI_WALLET_SECRET);

const PromoClaimSchema = new mongoose.Schema({
  piUid: { type: String, required: true, unique: true },
  piUsername: { type: String, required: true },
  amount: { type: Number, default: 0.1 },
  txid: { type: String },
  paymentId: { type: String },
  claimedAt: { type: Date, default: Date.now }
});
const PromoClaim = mongoose.model('PromoClaim', PromoClaimSchema);

// تحقق من حالة المستخدم: هل يمكنه السحب؟
app.post('/api/promo-status', async (req, res) => {
  const { piUid } = req.body;
  if (!piUid) return res.status(400).json({ error: 'piUid required' });

  try {
    const alreadyClaimed = await PromoClaim.findOne({ piUid });
    const totalClaims = await PromoClaim.countDocuments();

    res.json({
      success: true,
      alreadyClaimed: !!alreadyClaimed,
      slotsLeft: Math.max(0, 5 - totalClaims),
      isEligible: !alreadyClaimed && totalClaims < 5
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// طلب السحب A2U
app.post('/api/claim-promo', async (req, res) => {
  const { piUid, piUsername, accessToken } = req.body;
  if (!piUid || !piUsername || !accessToken) {
    return res.status(400).json({ error: 'Missing data' });
  }

  try {
    // 1. التحقق من صحة المستخدم عبر Pi API
    const verifyRes = await axios.get('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (verifyRes.data.uid !== piUid) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    // 2. تحقق إن كان قد سحب من قبل
    const alreadyClaimed = await PromoClaim.findOne({ piUid });
    if (alreadyClaimed) {
      return res.status(400).json({ error: 'You have already claimed this reward' });
    }

    // 3. تحقق من عدد السحوبات الكلي (أول 5 فقط)
    const totalClaims = await PromoClaim.countDocuments();
    if (totalClaims >= 5) {
      return res.status(400).json({ error: 'Promo limit reached. No slots left.' });
    }

    // 4. حجز السلوت فوراً لمنع التسابق (race condition) بين عدة طلبات متزامنة
    let reservation;
    try {
      reservation = await PromoClaim.create({
        piUid,
        piUsername,
        amount: 0.1,
        txid: null,
        paymentId: null
      });
    } catch (dupErr) {
      return res.status(400).json({ error: 'You have already claimed this reward' });
    }

    // إعادة التحقق من العدد بعد الحجز (تحسباً لتزامن نادر)
    const recountAfterReserve = await PromoClaim.countDocuments();
    if (recountAfterReserve > 5) {
      await PromoClaim.deleteOne({ _id: reservation._id });
      return res.status(400).json({ error: 'Promo limit reached. No slots left.' });
    }

    // 5. تنفيذ دفعة A2U فعلية
    let paymentId = null;
    try {
      paymentId = await piSDK.createPayment({
        amount: 0.1,
        memo: "CexPi - Early Adopter Reward",
        metadata: { type: "promo_reward", piUid, piUsername },
        uid: piUid
      });

      const txid = await piSDK.submitPayment(paymentId);
      const completed = await piSDK.completePayment(paymentId, txid);

      reservation.txid = txid;
      reservation.paymentId = paymentId;
      await reservation.save();

      return res.json({
        success: true,
        amount: 0.1,
        txid,
        status: completed.status
      });

    } catch (payErr) {
      // فشل الدفع → نلغي الحجز حتى لا نخسر سلوت بدون داعٍ
      console.error('A2U payment error:', payErr.message);
      await PromoClaim.deleteOne({ _id: reservation._id });
      if (paymentId) {
        try { await piSDK.cancelPayment(paymentId); } catch (ce) {}
      }
      return res.status(500).json({ error: 'Payment failed. Please try again.' });
    }

  } catch (e) {
    console.error('Claim promo error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});


app.get('/', (req, res) => res.send('<h1>CexPi Backend - Running</h1>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


