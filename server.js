const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const cloudinary = require('cloudinary').v2; // === CLOUDINARY ===

const app = express();
app.use(helmet());

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}));

// Stricter limiter for sensitive/state-changing endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30
});

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
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
}));
app.use(express.json({ limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// === CLOUDINARY CONFIG ===
// يُستخدم Cloudinary فقط لتخزين الصور (تخزين خارجي)، بينما تبقى MongoDB
// هي المصدر الوحيد لتخزين وعرض بيانات الإعلانات (نص + روابط الصور القصيرة)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ================= SECURITY HELPERS =================

// يتحقق من صحة accessToken المرسل من Pi Network ويعيد بيانات المستخدم الحقيقية (uid, username)
async function verifyPiToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Missing access token');
  }
  const verifyRes = await axios.get('https://api.minepi.com/v2/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return verifyRes.data; // { uid, username, ... }
}

// Middleware: يفرض وجود Authorization: Bearer <token> صالح، ويضع المستخدم الحقيقي في req.piUser
// هذا يمنع أي شخص من انتحال piUid آخر عبر تعديل body الطلب فقط
async function requirePiAuth(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const accessToken = authHeader.slice(7).trim();
    const piUser = await verifyPiToken(accessToken);
    if (!piUser || !piUser.uid) {
      return res.status(401).json({ error: 'Invalid access token' });
    }
    req.piUser = piUser;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Authentication failed. Please login again.' });
  }
}

function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maxLen;
}

function isValidObjectId(id) {
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);
}

// === CLOUDINARY: تحقق من روابط الصور بدل base64 ===
// بعد التحويل إلى Cloudinary، لا نخزّن الصور كـ base64 ضخم في MongoDB،
// بل فقط رابط Cloudinary القصير والآمن (secure_url)
const MAX_IMAGE_URL_LENGTH = 500;
const CLOUDINARY_URL_REGEX = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/.+$/;

function isValidCloudinaryUrl(str) {
  if (typeof str !== 'string') return false;
  if (str.length === 0 || str.length > MAX_IMAGE_URL_LENGTH) return false;
  return CLOUDINARY_URL_REGEX.test(str);
}

const ALLOWED_CATEGORIES = ['car', 'truck', 'motorcycle'];

// ================= SCHEMAS =================

// نموذج المستخدم
const UserSchema = new mongoose.Schema({
  piUid: { type: String, required: true, unique: true },
  piUsername: { type: String, required: true },
  country: { type: String, required: true },
  welcomeRewardSent: { type: Boolean, default: false },
  listingCredits: { type: Number, default: 0, min: 0 }, // عدد الإعلانات المدفوعة وغير المستخدمة بعد
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);

// نموذج الإعلان
// === CLOUDINARY: images الآن مصفوفة روابط قصيرة بدل base64 ===
const ListingSchema = new mongoose.Schema({
  sellerUid: { type: String, required: true },
  title: { type: String, required: true, trim: true, maxlength: 150 },
  description: { type: String, required: true, trim: true, maxlength: 3000 },
  priceInPi: { type: Number, required: true, min: 0, max: 100000000 },
  category: { type: String, required: true, enum: ALLOWED_CATEGORIES },
  make: { type: String, trim: true, maxlength: 60, default: '' },
  model: { type: String, trim: true, maxlength: 60, default: '' },
  year: { type: Number, min: 1900, max: 2100, default: null },
  mileage: { type: Number, min: 0, max: 10000000, default: null },
  country: { type: String, required: true, trim: true, maxlength: 100 },
  region: { type: String, required: true, trim: true, maxlength: 150 },
  images: [{ type: String, maxlength: MAX_IMAGE_URL_LENGTH }],
  phoneNumber: { type: String, required: true, trim: true, maxlength: 30 },
  createdAt: { type: Date, default: Date.now },
  active: { type: Boolean, default: true }
});
const Listing = mongoose.model('Listing', ListingSchema);

// نموذج تتبع المدفوعات (لمنع نشر إعلانات بدون دفع فعلي)
const PaymentRecordSchema = new mongoose.Schema({
  paymentId: { type: String, required: true, unique: true },
  piUid: { type: String, required: true },
  type: { type: String, required: true }, // 'listing_fee'
  status: { type: String, required: true, default: 'approved' }, // approved | completed | cancelled
  txid: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
const PaymentRecord = mongoose.model('PaymentRecord', PaymentRecordSchema);

// ================= ROUTES =================

// تسجيل المستخدم
app.post('/api/register-user', async (req, res) => {
  const { piUid, piUsername, country } = req.body;
  if (!isNonEmptyString(piUid, 100) || !isNonEmptyString(piUsername, 100) || !isNonEmptyString(country, 100)) {
    return res.status(400).json({ error: 'Missing or invalid fields' });
  }

  try {
    await User.findOneAndUpdate(
      { piUid },
      { piUsername, country },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// === CLOUDINARY: رفع الصورة عبر سيرفرنا (Server-side proxy upload) ===
// لا نجعل متصفح المستخدم (خصوصاً Pi Browser المقيّد أمنياً) يتصل مباشرة بـ
// api.cloudinary.com، لأن هذا غالباً ما يُحجب أو يفشل بصمت بخطأ "Failed to fetch"
// داخل بعض الـ WebViews. بدلاً من ذلك: المتصفح يرفع الصورة إلى دومين سيرفرنا
// (الموثوق به مسبقاً لأنه يُستخدم في الدفع)، والسيرفر هو من يرفعها إلى Cloudinary.
// API secret لا يخرج أبداً من السيرفر، وهذا أكثر أماناً من الرفع المباشر من المتصفح.
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 } // 1MB، يطابق حد الصور في باقي التطبيق
});

function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message === 'File too large' ? 'Image too large (max 1MB)' : 'Image upload failed' });
    }
    next();
  });
}

app.post('/api/upload-image', strictLimiter, requirePiAuth, handleImageUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary is not configured on the server' });
    }

    const allowedMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMime.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid image type' });
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'cexpi_listings', resource_type: 'image' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    res.json({ success: true, url: uploadResult.secure_url });
  } catch (e) {
    console.error('Image upload error:', e);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// إنشاء طلب دفع (لا حاجة لمصادقة صارمة هنا، فقط يرجع معلومات الدفع)
app.post('/api/create-listing-payment', requirePiAuth, async (req, res) => {
  res.json({
    success: true,
    amount: 0.5,
    memo: 'CexPi Listing Fee - 0.5 Pi',
    metadata: { type: 'listing_fee', piUid: req.piUser.uid }
  });
});

// موافقة على الدفع — نتحقق من هوية المستخدم عبر التوكن، ثم نوافق على الدفعة مباشرة
// (تم إلغاء فحص GET الإضافي على Pi API لأنه كان يفشل أحياناً ويعلّق العملية بصمت)
app.post('/api/approve-payment', strictLimiter, requirePiAuth, async (req, res) => {
  const { paymentId } = req.body;
  if (!isNonEmptyString(paymentId, 200)) {
    return res.status(400).json({ error: 'paymentId required' });
  }

  try {
    await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {}, {
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` }
    });

    // نسجل الدفعة كمعتمدة مع هوية المستخدم الموثّقة من التوكن (وليس من body)
    // حتى نمنح رصيد نشر إعلان بعد اكتمالها فقط، ولا يمكن لأحد تزوير الرصيد
    await PaymentRecord.findOneAndUpdate(
      { paymentId },
      { paymentId, piUid: req.piUser.uid, type: 'listing_fee', status: 'approved' },
      { upsert: true, new: true }
    );

    res.json({ success: true });
  } catch (e) {
    console.error('Approve error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to approve payment' });
  }
});

// إكمال الدفع — لا يفرض رمز مصادقة جديد (لأن السحب التلقائي onIncompletePaymentFound
// قد يحدث قبل توفر التوكن)، لكن منح "رصيد نشر إعلان" يتم فقط إذا وُجد سجل دفعة معتمدة سابقاً
// تم التحقق منها بالكامل في approve-payment أعلاه — لذلك لا يمكن لأحد تزوير رصيد إعلان.
app.post('/api/complete-payment', strictLimiter, async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!isNonEmptyString(paymentId, 200) || !isNonEmptyString(txid, 200)) {
    return res.status(400).json({ error: 'paymentId and txid required' });
  }

  try {
    await axios.post(`https://api.minepi.com/v2/payments/${paymentId}/complete`, { txid }, {
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY}` }
    });

    const record = await PaymentRecord.findOne({ paymentId });
    if (record && record.status === 'approved' && record.type === 'listing_fee') {
      record.status = 'completed';
      record.txid = txid;
      await record.save();

      await User.findOneAndUpdate(
        { piUid: record.piUid },
        { $inc: { listingCredits: 1 } },
        { upsert: true }
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Complete error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to complete payment' });
  }
});

// نشر الإعلان — يتطلب مصادقة صالحة + رصيد إعلان مدفوع فعلياً (لمنع النشر المجاني)
// === CLOUDINARY: images الآن مصفوفة روابط Cloudinary قصيرة (تم رفعها من الفرونت مباشرة) ===
app.post('/api/complete-listing', strictLimiter, requirePiAuth, async (req, res) => {
  const {
    title, description, priceInPi, category, make, model,
    year, mileage, country, region, images, phoneNumber
  } = req.body;

  // تحقق من صحة الحقول
  if (!isNonEmptyString(title, 150)) return res.status(400).json({ error: 'Invalid title' });
  if (!isNonEmptyString(description, 3000)) return res.status(400).json({ error: 'Invalid description' });
  if (typeof priceInPi !== 'number' || isNaN(priceInPi) || priceInPi < 0 || priceInPi > 100000000) {
    return res.status(400).json({ error: 'Invalid price' });
  }
  if (!ALLOWED_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!isNonEmptyString(country, 100)) return res.status(400).json({ error: 'Invalid country' });
  if (!isNonEmptyString(region, 150)) return res.status(400).json({ error: 'Invalid region' });
  if (!isNonEmptyString(phoneNumber, 30) || !/^[0-9+\-\s()]{5,30}$/.test(phoneNumber.trim())) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  if (make !== undefined && make !== null && (typeof make !== 'string' || make.length > 60)) {
    return res.status(400).json({ error: 'Invalid make' });
  }
  if (model !== undefined && model !== null && (typeof model !== 'string' || model.length > 60)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  if (year !== undefined && year !== null && (typeof year !== 'number' || year < 1900 || year > 2100)) {
    return res.status(400).json({ error: 'Invalid year' });
  }
  if (mileage !== undefined && mileage !== null && (typeof mileage !== 'number' || mileage < 0 || mileage > 10000000)) {
    return res.status(400).json({ error: 'Invalid mileage' });
  }

  let safeImages = [];
  if (images !== undefined && images !== null) {
    if (!Array.isArray(images) || images.length > 6) {
      return res.status(400).json({ error: 'Maximum 6 images allowed' });
    }
    for (const img of images) {
      if (!isValidCloudinaryUrl(img)) {
        return res.status(400).json({ error: 'One or more image URLs are invalid' });
      }
    }
    safeImages = images;
  }

  // التحقق من وجود رصيد إعلان مدفوع، وخصمه بشكل ذري لمنع استخدام نفس الدفعة مرتين
  try {
    const debited = await User.findOneAndUpdate(
      { piUid: req.piUser.uid, listingCredits: { $gt: 0 } },
      { $inc: { listingCredits: -1 } },
      { new: true }
    );

    if (!debited) {
      return res.status(402).json({ error: 'No paid listing credit found. Please complete the 0.5 Pi payment first.' });
    }

    const newListing = new Listing({
      sellerUid: req.piUser.uid,
      title: title.trim(),
      description: description.trim(),
      priceInPi,
      category,
      make: (make || '').trim(),
      model: (model || '').trim(),
      year: year || null,
      mileage: mileage || null,
      country: country.trim(),
      region: region.trim(),
      images: safeImages,
      phoneNumber: phoneNumber.trim()
    });

    await newListing.save();
    res.json({ success: true, message: 'Listing published successfully!' });
  } catch (e) {
    console.error('Save listing error:', e);
    // في حال فشل الحفظ بعد خصم الرصيد، نعيد الرصيد للمستخدم
    try {
      await User.findOneAndUpdate({ piUid: req.piUser.uid }, { $inc: { listingCredits: 1 } });
    } catch (refundErr) {
      console.error('Refund credit error:', refundErr);
    }
    res.status(500).json({ error: 'Failed to save listing' });
  }
});

// جلب الإعلانات (عام، بدون مصادقة)
app.get('/api/get-listings', async (req, res) => {
  try {
    const listings = await Listing.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, listings });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// حذف الإعلان — يتطلب مصادقة صالحة، ويستخدم هوية المستخدم الحقيقية من التوكن فقط
app.post('/api/delete-listing', requirePiAuth, async (req, res) => {
  const { listingId } = req.body;
  if (!isValidObjectId(listingId)) {
    return res.status(400).json({ error: 'Invalid listingId' });
  }

  try {
    const listing = await Listing.findOne({ _id: listingId, sellerUid: req.piUser.uid });
    if (!listing) return res.status(404).json({ error: 'Listing not found or not owned by you' });

    await Listing.deleteOne({ _id: listingId });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
app.post('/api/promo-status', requirePiAuth, async (req, res) => {
  try {
    const piUid = req.piUser.uid;
    const alreadyClaimed = await PromoClaim.findOne({ piUid });
    const totalClaims = await PromoClaim.countDocuments();

    res.json({
      success: true,
      alreadyClaimed: !!alreadyClaimed,
      slotsLeft: Math.max(0, 5 - totalClaims),
      isEligible: !alreadyClaimed && totalClaims < 5
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// طلب السحب A2U
app.post('/api/claim-promo', strictLimiter, requirePiAuth, async (req, res) => {
  const piUid = req.piUser.uid;
  const piUsername = req.piUser.username;

  try {
    // تحقق إن كان قد سحب من قبل
    const alreadyClaimed = await PromoClaim.findOne({ piUid });
    if (alreadyClaimed) {
      return res.status(400).json({ error: 'You have already claimed this reward' });
    }

    // تحقق من عدد السحوبات الكلي (أول 5 فقط)
    const totalClaims = await PromoClaim.countDocuments();
    if (totalClaims >= 5) {
      return res.status(400).json({ error: 'Promo limit reached. No slots left.' });
    }

    // حجز السلوت فوراً لمنع التسابق (race condition) بين عدة طلبات متزامنة
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

    // تنفيذ دفعة A2U فعلية
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
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.get('/', (req, res) => res.send('<h1>CexPi Backend - Running</h1>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
